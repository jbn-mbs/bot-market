import { createHmac, timingSafeEqual } from "node:crypto";
import type { Api } from "grammy";
import { config } from "../../config.js";
import { db, must } from "../../db.js";
import { esc } from "../../core/format.js";
import { recordAndAlert, runSeedAudit } from "./checks.js";

/** Constant-time string comparison for secrets and signatures. */
export function safeEqual(a: string, b: string) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function verifyVercel(raw: string, sig: string | null) {
  if (!config.vercelWebhookSecret || !sig) return false;
  return safeEqual(createHmac("sha1", config.vercelWebhookSecret).update(raw).digest("hex"), sig);
}

export function verifyGithub(raw: string, sig: string | null) {
  if (!config.githubWebhookSecret || !sig) return false;
  return safeEqual(`sha256=${createHmac("sha256", config.githubWebhookSecret).update(raw).digest("hex")}`, sig);
}

const post = (api: Api, html: string) =>
  config.devGroupId
    ? api.sendMessage(config.devGroupId, html, { parse_mode: "HTML", link_preview_options: { is_disabled: true } }).catch((e) => console.error(e))
    : Promise.resolve();

const VERCEL_STATE: Record<string, string> = {
  "deployment.created": "started",
  "deployment.succeeded": "ready",
  "deployment.ready": "ready",
  "deployment.error": "failed",
  "deployment.canceled": "canceled",
};

/**
 * GitHub sends either application/json or (the UI default) application/x-www-form-urlencoded
 * with the JSON in a `payload` field. Accept both.
 */
export function parseGithubPayload(raw: string, contentType: string | null): any {
  if ((contentType ?? "").includes("application/x-www-form-urlencoded")) {
    const payload = new URLSearchParams(raw).get("payload");
    if (!payload) throw new Error("form body without payload field");
    return JSON.parse(payload);
  }
  return JSON.parse(raw);
}

/** Vercel deployment events for team jbn7. Production success also triggers the seed audit. */
export async function handleVercel(api: Api, evt: any) {
  const state = VERCEL_STATE[evt.type];
  if (!state) return { ignored: evt.type };
  const p = evt.payload ?? {};
  const d = p.deployment ?? {};
  const meta = d.meta ?? {};
  const row = {
    id: d.id, project: d.name ?? p.name, target: p.target ?? "preview", state,
    url: d.url ? `https://${d.url}` : null, branch: meta.githubCommitRef ?? null,
    commit_message: meta.githubCommitMessage ?? null, updated_at: new Date().toISOString(),
  };
  // The team webhook covers every project (including this bot); only track the configured ones.
  const projects = config.vercelProjects;
  if (projects.length && !projects.includes(row.project)) return { ignored: `project ${row.project}` };

  // Vercel can send more than one event for the same state (succeeded + ready) and retries on
  // timeouts. Announce and audit only when the stored state actually changes.
  if (row.id) {
    const { data: prev } = await db().from("deploys").select("state").eq("id", row.id).maybeSingle();
    if (prev?.state === state) return { state, duplicate: true };
    must(await db().from("deploys").upsert(row));
  }

  const icon = { started: "⏳", ready: "✅", failed: "❌", canceled: "⛔" }[state];
  // Previews are noisy: only announce their failures.
  if (row.target === "production" || state === "failed") {
    await post(api, `${icon} Deploy <b>${esc(state)}</b> · ${esc(row.project)} (${esc(row.target)})` +
      `${row.branch ? ` · ${esc(row.branch)}` : ""}\n${esc((row.commit_message ?? "").split("\n")[0].slice(0, 100))}` +
      `${row.url && state !== "started" ? `\n${esc(row.url)}` : ""}`);
  }
  if (row.target === "production" && state === "ready") {
    await recordAndAlert(api, await runSeedAudit());
  }
  return { state };
}

/** GitHub events for careerGuide: PRs opened/merged, CI results, bug issues closed. */
export async function handleGithub(api: Api, event: string, body: any) {
  if (event === "pull_request") {
    const pr = body.pull_request;
    if (body.action === "opened" || body.action === "ready_for_review") {
      await post(api, `🔀 PR #${pr.number} opened by ${esc(pr.user?.login)}: <a href="${esc(pr.html_url)}">${esc(pr.title)}</a>`);
    } else if (body.action === "closed" && pr.merged) {
      await post(api, `🟣 PR #${pr.number} merged into ${esc(pr.base?.ref)}: <a href="${esc(pr.html_url)}">${esc(pr.title)}</a>`);
    }
  } else if (event === "workflow_run" && body.action === "completed") {
    const run = body.workflow_run;
    const passed = run.conclusion === "success";
    // Announce every failure, but only successes on main (to show it went green again).
    if (!passed || run.head_branch === "main") {
      await post(api, `${passed ? "🟢" : "🔴"} CI <b>${esc(run.name)}</b> ${esc(run.conclusion)} on ${esc(run.head_branch)}` +
        ` · <a href="${esc(run.html_url)}">logs</a>`);
    }
  } else if (event === "issues" && body.action === "closed") {
    await db().from("bug_reports").update({ state: "closed" }).eq("github_number", body.issue.number);
  }
  return { ok: true };
}
