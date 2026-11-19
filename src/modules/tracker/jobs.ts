import type { Api } from "grammy";
import { esc } from "../../core/format.js";
import { localDate } from "../../core/time.js";
import { config } from "../../config.js";
import { deadlineView, doneMap, openDeliverables, teamProgress } from "./logic.js";
import * as repo from "./repo.js";
import { statusTable } from "./commands.js";

async function safeSend(api: Api, chatId: number | string, text: string) {
  try {
    await api.sendMessage(chatId, text, { parse_mode: "HTML" });
    return true;
  } catch (e) {
    // Most common cause: the person blocked the bot or never pressed Start.
    console.warn("send failed", chatId, (e as Error).message);
    return false;
  }
}

async function load() {
  const project = await repo.activeProject();
  if (!project) return null;
  const items = await repo.projectItems(project.id);
  const subs = await repo.projectSubmissions(items.map((i) => i.id));
  return { project, items, subs, done: doneMap(project.deliverable_types, subs), people: await repo.trackerPeople(items) };
}

/** 09:30 IST: each member gets their open items. */
export async function morningDm(api: Api) {
  const s = await load();
  if (!s) return { sent: 0 };
  let sent = 0;
  for (const p of s.people) {
    if (!p.chatId) continue;
    const open = s.items
      .filter((i) => i.owner_id === p.id)
      .map((i) => ({ i, open: openDeliverables(i, s.project.deliverable_types, s.done) }))
      .filter((x) => x.open.length);
    if (!open.length) continue;
    const top = open.slice(0, 5).map((x) => `• ${esc(x.i.title)}: ${esc(x.open.map((d) => d.label).join(", "))}`);
    const ok = await safeSend(api, p.chatId,
      `☀️ Good morning ${esc(p.name.split(" ")[0])}. You have <b>${open.length}</b> qualifications with open deliverables.\n\n` +
        top.join("\n") + (open.length > 5 ? `\n…and ${open.length - 5} more (/mytasks)` : "") + `\n\nLog work with /done.`);
    if (ok) sent++;
  }
  return { sent };
}

/** 18:00 IST: anyone who owns work but logged nothing today. */
export async function eveningNudge(api: Api) {
  const s = await load();
  if (!s) return { sent: 0 };
  const today = await repo.submissionsOnDay();
  const active = new Set(today.map((r) => r.by_person));
  let sent = 0;
  for (const p of s.people) {
    if (!p.chatId || active.has(p.id)) continue;
    const hasOpen = s.items.some((i) => i.owner_id === p.id && openDeliverables(i, s.project.deliverable_types, s.done).length);
    if (!hasOpen) continue;
    if (await safeSend(api, p.chatId, "⏰ Nothing logged today yet. If you worked on something, tap /done to record it.")) sent++;
  }
  return { sent };
}

/** Monday 10:00 IST: deficit report to the team group and founders. */
export async function weeklyReport(api: Api) {
  const t = await statusTable();
  if (!t) return { sent: 0 };
  const text = `📊 <b>Weekly deficit report</b>\n\n${t}`;
  let sent = 0;
  if (config.teamGroupId && (await safeSend(api, config.teamGroupId, text))) sent++;
  for (const chat of await repo.chatIdsForRole("founder")) if (await safeSend(api, chat, text)) sent++;
  return { sent };
}

/** 7, 3 and 1 days before the deadline: what is still missing, per person. */
export async function countdown(api: Api) {
  const s = await load();
  if (!s) return { sent: 0 };
  // Same count as /deadline (today included), so the two never disagree. 1 = the deadline is today.
  const { daysLeft } = deadlineView(s.project, 0, 0, localDate());
  if (![7, 3, 1].includes(daysLeft)) return { sent: 0, daysLeft };
  const prog = teamProgress(s.project, s.items, s.subs, localDate(), s.people.map((p) => p.id));
  const behind = prog.filter((p) => p.doneUnits < p.totalUnits)
    .map((p) => `• ${esc(s.people.find((x) => x.id === p.personId)!.name)}: ${p.totalUnits - p.doneUnits} units open`);
  const head = daysLeft === 1 ? `The ${esc(s.project.name)} deadline is today` : `${daysLeft} days left to the ${esc(s.project.name)} deadline`;
  const text = `⏳ <b>${head}</b> (${s.project.deadline}, today included)\n\n` +
    (behind.length ? behind.join("\n") : "Everyone is complete. 🎉");
  let sent = 0;
  if (config.teamGroupId && (await safeSend(api, config.teamGroupId, text))) sent++;
  for (const chat of await repo.chatIdsForRole("founder")) if (await safeSend(api, chat, text)) sent++;
  return { sent, daysLeft };
}

export { safeSend };
