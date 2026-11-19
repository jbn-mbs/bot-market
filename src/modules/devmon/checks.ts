import type { Api } from "grammy";
import { config } from "../../config.js";
import { db, must } from "../../db.js";
import { esc } from "../../core/format.js";
import { audit } from "../../core/audit.js";

export interface CheckResult { target: string; kind: "health" | "smoke" | "seed"; ok: boolean; detail: string; latencyMs?: number }

/** Strip anything that looks like a credential before it reaches a chat. */
export function scrub(s: string): string {
  return s
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer ***")
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "***jwt***")
    .replace(/(key|token|secret|password)=([^&\s]+)/gi, "$1=***")
    .slice(0, 300);
}

async function timed(url: string, init: RequestInit = {}, timeoutMs = 15_000) {
  const t0 = Date.now();
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs), redirect: "manual" });
  return { res, ms: Date.now() - t0 };
}

/**
 * Probes. Unauthenticated POSTs to protected routes should come back 401/400:
 * that proves the service and route are up without creating sessions or spending AI tokens.
 */
export function healthTargets() {
  const api = config.mbsApiBase;
  const t: { target: string; url: string; method: "GET" | "POST"; okIf: (s: number) => boolean }[] = [];
  if (config.mbsSiteUrl) t.push({ target: "site", url: config.mbsSiteUrl, method: "GET", okIf: (s) => s < 400 });
  if (api) {
    t.push({ target: "api:health", url: `${api}/health`, method: "GET", okIf: (s) => s === 200 });
    t.push({ target: "api:ai-chat", url: `${api}/ai/chat`, method: "POST", okIf: (s) => s < 500 });
    t.push({ target: "api:negotiation-v2", url: `${api}/simulations/negotiation-v2/sessions`, method: "POST", okIf: (s) => s < 500 });
    t.push({ target: "api:clarification", url: `${api}/v6/flows/user-6/sessions`, method: "POST", okIf: (s) => s < 500 });
  }
  return t;
}

export async function runHealth(): Promise<CheckResult[]> {
  return Promise.all(healthTargets().map(async (h): Promise<CheckResult> => {
    try {
      const { res, ms } = await timed(h.url, {
        method: h.method,
        headers: h.method === "POST" ? { "content-type": "application/json" } : {},
        body: h.method === "POST" ? "{}" : undefined,
      });
      return { target: h.target, kind: "health", ok: h.okIf(res.status), detail: `HTTP ${res.status}`, latencyMs: ms };
    } catch (e) {
      const name = (e as Error).name;
      return { target: h.target, kind: "health", ok: false, detail: name === "TimeoutError" ? "timeout (15s)" : scrub((e as Error).message) };
    }
  }));
}

/** Sign the dedicated smoke-test account in against the MBS Supabase project. */
async function smokeToken(): Promise<string> {
  const { mbsSupabaseUrl: url, mbsSupabaseAnonKey: anon, smokeEmail: email, smokePassword: password } = config;
  if (!url || !anon || !email || !password) throw new Error("smoke account not configured");
  const res = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: anon, "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`smoke login failed: HTTP ${res.status}`);
  return (await res.json()).access_token;
}

async function getFlow(flow: string, token: string) {
  const { res, ms } = await timed(`${config.mbsApiBase}/assessment/user-flows/${flow}`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`flow ${flow}: HTTP ${res.status}`);
  const body = await res.json();
  return { flow: body?.data?.flow, ms };
}

/**
 * Hourly: for each assessment track, load the flow and fetch the first playable block's
 * content. This is the path that broke when MOT_18–28 were missing from the live DB.
 */
export async function runSmoke(): Promise<CheckResult[]> {
  let token: string;
  try { token = await smokeToken(); } catch (e) {
    return [{ target: "smoke:login", kind: "smoke", ok: false, detail: scrub((e as Error).message) }];
  }
  // Flows run in parallel: worst case is login + 2 timeouts (~45 s), inside the 60 s function limit.
  const flows = await Promise.all(config.smokeFlows.map(async (flowKey): Promise<CheckResult> => {
    const target = `smoke:${flowKey}`;
    try {
      const { flow, ms } = await getFlow(flowKey, token);
      let pi = -1, bi = -1;
      flow?.phases?.some((p: any, i: number) => p.blocks?.some((b: any, j: number) => (b.playable ? ((pi = i), (bi = j), true) : false)));
      if (pi < 0) return { target, kind: "smoke", ok: false, detail: "no playable block", latencyMs: ms };
      const { res, ms: ms2 } = await timed(
        `${config.mbsApiBase}/assessment/user-flows/${flowKey}/phases/${pi}/blocks/${bi}/content`,
        { headers: { authorization: `Bearer ${token}` } });
      const body = res.ok ? await res.json() : null;
      const data = body?.data;
      const hasContent = !!data && JSON.stringify(data).length > 20;
      return { target, kind: "smoke", ok: res.ok && hasContent,
        detail: res.ok ? (hasContent ? `first block ${pi}.${bi} ok` : `block ${pi}.${bi} empty`) : `block ${pi}.${bi}: HTTP ${res.status}`,
        latencyMs: ms + ms2 };
    } catch (e) {
      return { target, kind: "smoke", ok: false, detail: scrub((e as Error).message) };
    }
  }));
  return [{ target: "smoke:login", kind: "smoke", ok: true, detail: "ok" }, ...flows];
}

/**
 * Nightly and after deploys: the API equivalent of backend/scripts/audit-assessment-counts.mjs.
 * Any item ID a flow plans to use that is not in the bank shows up as stats.missingItemRefs.
 */
export async function runSeedAudit(): Promise<CheckResult[]> {
  let token: string;
  try { token = await smokeToken(); } catch (e) {
    return [{ target: "seed:login", kind: "seed", ok: false, detail: scrub((e as Error).message) }];
  }
  const flows = await Promise.all(config.smokeFlows.map(async (flowKey): Promise<CheckResult> => {
    try {
      const { flow } = await getFlow(flowKey, token);
      const missing: string[] = [];
      for (const p of flow?.phases ?? []) for (const b of p.blocks ?? []) missing.push(...(b.missingIds ?? []));
      return { target: `seed:${flowKey}`, kind: "seed", ok: missing.length === 0,
        detail: missing.length ? `${missing.length} planned codes not seeded: ${missing.slice(0, 8).join(", ")}${missing.length > 8 ? "…" : ""}` : "all planned codes seeded" };
    } catch (e) {
      return { target: `seed:${flowKey}`, kind: "seed", ok: false, detail: scrub((e as Error).message) };
    }
  }));
  // Report login success too; otherwise a past seed:login failure never resolves.
  return [{ target: "seed:login", kind: "seed", ok: true, detail: "ok" }, ...flows];
}

/** Consecutive failures before an incident opens. Health runs every 5 min, so a single blip (e.g. a cold start) is ignored. */
export const FAIL_THRESHOLD: Record<CheckResult["kind"], number> = { health: 2, smoke: 1, seed: 1 };

export interface CheckState { consec_fails: number; alerting: boolean }

/** Pure alert state machine: open an incident once the threshold is hit, resolve on the first success. */
export function nextCheckState(prev: CheckState | undefined, ok: boolean, threshold: number):
  CheckState & { action: "open" | "resolve" | null } {
  const p = prev ?? { consec_fails: 0, alerting: false };
  if (ok) return { consec_fails: 0, alerting: false, action: p.alerting ? "resolve" : null };
  const consec = p.consec_fails + 1;
  if (!p.alerting && consec >= threshold) return { consec_fails: consec, alerting: true, action: "open" };
  return { consec_fails: consec, alerting: p.alerting, action: null };
}

/**
 * Persist results and alert the dev group only on state changes (failing past the threshold
 * opens an incident, the next success resolves it), so a long outage is one alert plus one recovery.
 */
export async function recordAndAlert(api: Api, results: CheckResult[]) {
  const targets = results.map((r) => r.target);
  const prev = must(await db().from("checks").select("target, consec_fails, alerting").in("target", targets)) as ({ target: string } & CheckState)[];
  const prevMap = new Map(prev.map((p) => [p.target, p]));
  const now = new Date().toISOString();
  const next = new Map(results.map((r) => [r.target, nextCheckState(prevMap.get(r.target), r.ok, FAIL_THRESHOLD[r.kind])]));

  must(await db().from("checks").upsert(results.map((r) => ({
    target: r.target, kind: r.kind, last_status: r.ok ? "ok" : "fail",
    last_checked_at: now, last_latency_ms: r.latencyMs ?? null, last_detail: r.detail,
    consec_fails: next.get(r.target)!.consec_fails, alerting: next.get(r.target)!.alerting,
  }))));

  const alerts: string[] = [];
  for (const r of results) {
    const { action } = next.get(r.target)!;
    if (action === "open") {
      must(await db().from("incidents").insert({ target: r.target, kind: r.kind, detail: r.detail }));
      alerts.push(`🔴 <b>${esc(r.target)}</b> is failing: ${esc(r.detail)}`);
    } else if (action === "resolve") {
      const open = must(await db().from("incidents").update({ resolved_at: now })
        .eq("target", r.target).is("resolved_at", null).select("opened_at")) as { opened_at: string }[];
      const mins = open[0] ? Math.round((Date.now() - Date.parse(open[0].opened_at)) / 60_000) : null;
      alerts.push(`🟢 <b>${esc(r.target)}</b> recovered${mins != null ? ` after ${mins} min` : ""}.`);
    }
  }
  if (alerts.length && config.devGroupId) {
    await api.sendMessage(config.devGroupId, alerts.join("\n"), { parse_mode: "HTML" }).catch((e) => console.error(e));
    await audit("system", "devmon.alert", undefined, { alerts: alerts.length });
  }
  return { checked: results.length, alerts: alerts.length };
}
