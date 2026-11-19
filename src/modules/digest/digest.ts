/**
 * C · Founder Digest. Starts with sections for A (tracker) and B (dev monitor);
 * later modules add a section function to SECTIONS.
 */
import type { Api } from "grammy";
import { db, must } from "../../db.js";
import { esc, signed } from "../../core/format.js";
import { addDays, localDate, localMidnightUtc } from "../../core/time.js";
import { teamProgress } from "../tracker/logic.js";
import * as repo from "../tracker/repo.js";
import { safeSend } from "../tracker/jobs.js";
import { digestHeadline } from "../../ai/summary.js";

type Range = { from: string; to: string; label: string };

function dayRange(date = localDate()): Range {
  const from = localMidnightUtc(date);
  return { from: from.toISOString(), to: new Date(from.getTime() + 86_400_000).toISOString(), label: date };
}

function weekRange(endDate = localDate(), weeksBack = 0): Range {
  const end = addDays(endDate, -7 * weeksBack);
  const start = addDays(end, -6);
  return { from: localMidnightUtc(start).toISOString(), to: new Date(localMidnightUtc(end).getTime() + 86_400_000).toISOString(), label: `${start}…${end}` };
}

async function unitsLogged(r: Range) {
  const rows = must(await db().from("submissions").select("qty").gte("at", r.from).lt("at", r.to)) as { qty: number }[];
  return rows.reduce((n, x) => n + x.qty, 0);
}

async function trackerSection(r: Range, prev?: Range): Promise<string> {
  const project = await repo.activeProject();
  if (!project) return "📋 <b>Team Tracker</b>\nNo active project.";
  const items = await repo.projectItems(project.id);
  const subs = await repo.projectSubmissions(items.map((i) => i.id));
  const people = await repo.trackerPeople(items);
  const prog = teamProgress(project, items, subs, localDate(), people.map((p) => p.id));
  const behind = prog.filter((p) => p.balance < 0).sort((a, b) => a.balance - b.balance);
  const teamBalance = prog.reduce((n, p) => n + p.balance, 0);
  const now = await unitsLogged(r);
  let line = `${now} units logged`;
  if (prev) {
    const before = await unitsLogged(prev);
    line += ` (last week ${before}, ${signed(now - before)})`;
  }
  return `📋 <b>Team Tracker</b>: ${esc(project.name)}\n${line} · team balance ${signed(teamBalance)}\n` +
    (behind.length
      ? `Behind target: ${behind.slice(0, 6).map((p) => `${esc(people.find((x) => x.id === p.personId)!.name.split(" ")[0])} ${p.balance}`).join(", ")}`
      : "Nobody is behind target.");
}

async function devSection(r: Range, weekly: boolean): Promise<string> {
  const opened = must(await db().from("incidents").select("target").gte("opened_at", r.from).lt("opened_at", r.to)) as any[];
  const open = must(await db().from("incidents").select("target, opened_at").is("resolved_at", null)) as any[];
  const deploys = must(await db().from("deploys").select("state, target").gte("updated_at", r.from).lt("updated_at", r.to)) as any[];
  const prod = deploys.filter((d) => d.target === "production");
  const lines = [
    `🛠 <b>Platform</b>`,
    open.length ? `🔴 ${open.length} check(s) failing now: ${esc(open.map((o) => o.target).join(", "))}` : "🟢 All checks passing",
    `${opened.length} incident(s) opened · ${prod.filter((d) => d.state === "ready").length} production deploy(s), ${deploys.filter((d) => d.state === "failed").length} failed`,
  ];
  if (weekly) {
    const bugs = must(await db().from("bug_reports").select("severity, title, url").eq("state", "open").in("severity", ["P0", "P1"])) as any[];
    lines.push(bugs.length
      ? `Open P0/P1 bugs (${bugs.length}):\n${bugs.slice(0, 8).map((b) => `• [${b.severity}] <a href="${esc(b.url)}">${esc(b.title)}</a>`).join("\n")}`
      : "No open P0/P1 bugs.");
  }
  return lines.join("\n");
}

/** Title, optional AI headline (skipped silently if AI is off or slow), then the computed sections. */
async function assemble(title: string, sections: string[]): Promise<string> {
  const headline = await digestHeadline([title, ...sections].join("\n\n"));
  return [title, ...(headline ? [`🧠 <i>${esc(headline)}</i>`] : []), ...sections].join("\n\n");
}

export async function dailyDigest(): Promise<string> {
  const r = dayRange();
  return assemble(`🌙 <b>JBN daily digest</b> · ${r.label}`, [await trackerSection(r), await devSection(r, false)]);
}

export async function weeklyDigest(): Promise<string> {
  const r = weekRange(addDays(localDate(), -1)); // Monday morning: the week that just ended
  const prev = weekRange(addDays(localDate(), -1), 1);
  return assemble(`📅 <b>JBN weekly digest</b> · ${r.label}`, [await trackerSection(r, prev), await devSection(r, true)]);
}

export async function sendToFounders(api: Api, text: string) {
  let sent = 0;
  for (const chat of await repo.chatIdsForRole("founder")) if (await safeSend(api, chat, text)) sent++;
  return { sent };
}
