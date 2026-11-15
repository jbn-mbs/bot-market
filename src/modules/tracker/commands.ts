import { Composer, InlineKeyboard } from "grammy";
import type { BotContext } from "../../core/context.js";
import { esc, signed, table } from "../../core/format.js";
import { localDate } from "../../core/time.js";
import { audit } from "../../core/audit.js";
import { db, must } from "../../db.js";
import { config } from "../../config.js";
import {
  deadlineView, doneMap, evaluatePick, openDeliverables, sectorsFromItems, teamProgress, unitsPerItem,
} from "./logic.js";
import * as repo from "./repo.js";

export const tracker = new Composer<BotContext>();
const PAGE = 8;

async function snapshot() {
  const project = await repo.activeProject();
  if (!project) return null;
  const items = await repo.projectItems(project.id);
  const subs = await repo.projectSubmissions(items.map((i) => i.id));
  return { project, items, subs, done: doneMap(project.deliverable_types, subs) };
}

const NO_PROJECT = "No active project yet. An admin needs to run the tracker import first.";

// ---------- /mytasks ----------
tracker.command("mytasks", async (ctx) => {
  const s = await snapshot();
  if (!s) return ctx.reply(NO_PROJECT);
  const mine = s.items.filter((i) => i.owner_id === ctx.person!.id);
  if (!mine.length) return ctx.reply("You don't own any qualifications yet. Use /sectors to pick yours.");

  const lines: string[] = [];
  let openCount = 0;
  for (const it of mine) {
    const open = openDeliverables(it, s.project.deliverable_types, s.done);
    if (!open.length) continue;
    openCount++;
    const parts = open.map((d) => (d.target > 1 ? `${d.label} ${d.done}/${d.target}` : d.label));
    lines.push(`• <b>${esc(it.title)}</b> <i>(${esc(it.sector)})</i>\n   ${esc(parts.join(" · "))}`);
  }
  if (!openCount) return ctx.reply("🎉 Everything you own is complete.");
  const shown = lines.slice(0, 25);
  const more = lines.length - shown.length;
  await ctx.reply(
    `<b>Your open items</b> (${openCount} of ${mine.length} qualifications)\n\n${shown.join("\n")}` +
      (more > 0 ? `\n\n…and ${more} more.` : "") + `\n\nLog work with /done.`,
    { parse_mode: "HTML" },
  );
});

// ---------- /done: item → deliverable → (qty) → optional file ----------
async function itemPicker(ctx: BotContext, page: number, edit: boolean) {
  const s = await snapshot();
  if (!s) return ctx.reply(NO_PROJECT);
  const open = s.items.filter((i) => i.owner_id === ctx.person!.id && openDeliverables(i, s.project.deliverable_types, s.done).length);
  if (!open.length) return ctx.reply("Nothing open to log. 🎉");
  const pages = Math.ceil(open.length / PAGE);
  page = Math.max(0, Math.min(page, pages - 1));
  const kb = new InlineKeyboard();
  for (const it of open.slice(page * PAGE, page * PAGE + PAGE)) kb.text(`${it.title}`.slice(0, 60), `dn:i:${it.id}`).row();
  if (pages > 1) {
    if (page > 0) kb.text("◀ Prev", `dn:p:${page - 1}`);
    kb.text(`${page + 1}/${pages}`, "noop");
    if (page < pages - 1) kb.text("Next ▶", `dn:p:${page + 1}`);
  }
  const text = "Which qualification did you work on?";
  return edit ? ctx.editMessageText(text, { reply_markup: kb }) : ctx.reply(text, { reply_markup: kb });
}

tracker.command("done", (ctx) => itemPicker(ctx, 0, false));
tracker.callbackQuery(/^dn:p:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await itemPicker(ctx, Number(ctx.match[1]), true);
});

tracker.callbackQuery(/^dn:i:([0-9a-f-]{36})$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const s = await snapshot();
  const item = s?.items.find((i) => i.id === ctx.match[1]);
  if (!s || !item || item.owner_id !== ctx.person!.id) return ctx.editMessageText("That item isn't yours any more.");
  const kb = new InlineKeyboard();
  for (const d of openDeliverables(item, s.project.deliverable_types, s.done)) {
    kb.text(d.target > 1 ? `${d.label} (${d.done}/${d.target})` : d.label, `dn:d:${item.id}:${d.key}`).row();
  }
  kb.text("◀ Back", "dn:p:0");
  await ctx.editMessageText(`<b>${esc(item.title)}</b>\nWhich deliverable?`, { parse_mode: "HTML", reply_markup: kb });
});

tracker.callbackQuery(/^dn:d:([0-9a-f-]{36}):(\w+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const [, itemId, key] = ctx.match;
  const s = await snapshot();
  const item = s?.items.find((i) => i.id === itemId);
  const d = item && openDeliverables(item, s!.project.deliverable_types, s!.done).find((x) => x.key === key);
  if (!s || !item || item.owner_id !== ctx.person!.id || !d) return ctx.editMessageText("Already complete or not yours.");
  if (d.target === 1) return record(ctx, itemId, key, 1);
  const remaining = d.target - d.done;
  const kb = new InlineKeyboard();
  for (const q of [...new Set([1, Math.min(5, remaining), remaining])]) kb.text(`+${q}`, `dn:q:${itemId}:${key}:${q}`);
  await ctx.editMessageText(`${esc(d.label)}: ${d.done}/${d.target} so far. How many did you add?`, { reply_markup: kb });
});

tracker.callbackQuery(/^dn:q:([0-9a-f-]{36}):(\w+):(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const [, itemId, key, q] = ctx.match;
  await record(ctx, itemId, key, Number(q));
});

async function record(ctx: BotContext, itemId: string, key: string, qty: number) {
  const project = await repo.activeProject();
  const id = await repo.logSubmission({ itemId, deliverable: key, by: ctx.person!.id, qty });
  await audit(ctx.person!.id, "submission.log", id, { itemId, key, qty });
  ctx.session.pendingDone = { submissionId: id, expires: Date.now() + 10 * 60_000 };
  await ctx.editMessageText(
    `✅ Logged <b>${esc(repo.deliverableLabel(project!.deliverable_types, key))}</b>${qty > 1 ? ` ×${qty}` : ""}.\n` +
      `Send the file now (within 10 minutes) to attach it, or carry on.`,
    { parse_mode: "HTML" },
  );
}

/** A document sent right after /done is attached to that submission. Other files pass through. */
tracker.on("message:document", async (ctx, next) => {
  const p = ctx.session.pendingDone;
  if (!p || p.expires < Date.now() || ctx.chat.type !== "private") return next();
  const doc = ctx.message.document;
  if ((doc.file_size ?? 0) > 20 * 1024 * 1024) {
    return ctx.reply("Telegram bots can only fetch files up to 20 MB. Please share a Drive link instead and send it as text.");
  }
  const file = await ctx.getFile();
  const res = await fetch(`https://api.telegram.org/file/bot${config.opsBotToken}/${file.file_path}`);
  const path = `submissions/${p.submissionId}/${doc.file_name ?? "file"}`;
  must(await db().storage.from(config.filesBucket).upload(path, await res.arrayBuffer(), {
    contentType: doc.mime_type ?? "application/octet-stream", upsert: true,
  }) as any);
  must(await db().from("submissions").update({ file_url: path }).eq("id", p.submissionId));
  ctx.session.pendingDone = undefined;
  await ctx.reply("📎 File attached.");
});

// ---------- /sectors ----------
async function renderSectors(ctx: BotContext, edit: boolean) {
  const project = await repo.activeProject();
  if (!project) return ctx.reply(NO_PROJECT);
  const sectors = sectorsFromItems(await repo.projectItems(project.id), await repo.picks(project.id));
  if (ctx.session.sectorDraft === undefined) {
    ctx.session.sectorDraft = sectors.filter((s) => s.ownerId === ctx.person!.id).map((s) => s.sector);
  }
  const draft = ctx.session.sectorDraft;
  const v = evaluatePick(draft, sectors, ctx.person!.id, project);
  const kb = new InlineKeyboard();
  sectors.forEach((s, i) => {
    const mark = draft.includes(s.sector) ? "✅ " : s.ownerId && s.ownerId !== ctx.person!.id ? "🔒 " : "";
    kb.text(`${mark}${s.sector} (${s.count})`.slice(0, 60), `sc:t:${i}`);
    if (i % 2 === 1) kb.row();
  });
  kb.row().text("💾 Save", "sc:save").text("✖ Cancel", "sc:cancel");
  const verdict = v.ok
    ? `${v.total} qualifications · <b>${v.sufficient ? "Sufficient" : "Insufficient"} selection</b> (need ${project.min_pick_quals})`
    : `⚠ ${esc(v.reason)}`;
  const text = `<b>Pick up to ${project.max_sectors} sectors</b>\nSelected: ${draft.length ? esc(draft.join(", ")) : "none"}\n${verdict}\n🔒 = taken by someone else`;
  const opts = { parse_mode: "HTML" as const, reply_markup: kb };
  return edit ? ctx.editMessageText(text, opts) : ctx.reply(text, opts);
}

tracker.command("sectors", async (ctx) => {
  if (ctx.chat.type !== "private") return ctx.reply("Please use /sectors in a DM with me.");
  ctx.session.sectorDraft = undefined;
  await renderSectors(ctx, false);
});

tracker.callbackQuery(/^sc:t:(\d+)$/, async (ctx) => {
  const project = await repo.activeProject();
  const sectors = sectorsFromItems(await repo.projectItems(project!.id), await repo.picks(project!.id));
  const s = sectors[Number(ctx.match[1])];
  if (!s) return ctx.answerCallbackQuery();
  if (s.ownerId && s.ownerId !== ctx.person!.id) return ctx.answerCallbackQuery({ text: `${s.sector} is already taken.` });
  const draft = new Set(ctx.session.sectorDraft ?? []);
  if (draft.has(s.sector)) draft.delete(s.sector);
  else if (draft.size >= project!.max_sectors) return ctx.answerCallbackQuery({ text: `At most ${project!.max_sectors} sectors.` });
  else draft.add(s.sector);
  ctx.session.sectorDraft = [...draft];
  await ctx.answerCallbackQuery();
  await renderSectors(ctx, true);
});

tracker.callbackQuery("sc:cancel", async (ctx) => {
  ctx.session.sectorDraft = undefined;
  await ctx.answerCallbackQuery();
  await ctx.editMessageText("No changes made.");
});

tracker.callbackQuery("sc:save", async (ctx) => {
  const project = (await repo.activeProject())!;
  const sectors = sectorsFromItems(await repo.projectItems(project.id), await repo.picks(project.id));
  const draft = ctx.session.sectorDraft ?? [];
  const v = evaluatePick(draft, sectors, ctx.person!.id, project);
  if (!v.ok) return ctx.answerCallbackQuery({ text: v.reason, show_alert: true });
  try {
    const r = await repo.savePicks(project.id, ctx.person!.id,
      draft.map((d) => ({ sector: d, count: sectors.find((s) => s.sector === d)!.count })));
    await audit(ctx.person!.id, "sectors.save", project.id, r);
  } catch {
    await ctx.answerCallbackQuery({ text: "Someone just took one of those sectors. Refreshing…", show_alert: true });
    return renderSectors(ctx, true);
  }
  ctx.session.sectorDraft = undefined;
  await ctx.answerCallbackQuery({ text: "Saved" });
  await ctx.editMessageText(
    `Saved: ${esc(draft.join(", ") || "none")}\n${v.total} qualifications · <b>${v.sufficient ? "Sufficient" : "Insufficient"} selection</b>`,
    { parse_mode: "HTML" },
  );
});

// ---------- /status and /deadline ----------
export async function statusTable(): Promise<string | null> {
  const s = await snapshot();
  if (!s) return null;
  const people = await repo.trackerPeople();
  const prog = teamProgress(s.project, s.items, s.subs, localDate(), people.map((p) => p.id));
  const rows = prog
    .map((p) => ({ p, name: people.find((x) => x.id === p.personId)!.name }))
    .sort((a, b) => a.p.balance - b.p.balance)
    .map(({ p, name }) => [name.split(" ")[0].slice(0, 12), p.items, p.doneUnits, p.requiredToDate, signed(p.balance)]);
  return `<b>${esc(s.project.name)}</b>: team status\n` + table(["Name", "Quals", "Done", "Req", "+/-"], rows) +
    `<i>Req = units due by today on a straight-line plan.</i>`;
}

tracker.command("status", async (ctx) => {
  const t = await statusTable();
  await ctx.reply(t ?? NO_PROJECT, { parse_mode: "HTML" });
});

tracker.command("deadline", async (ctx) => {
  const s = await snapshot();
  if (!s) return ctx.reply(NO_PROJECT);
  const per = unitsPerItem(s.project.deliverable_types);
  const owned = s.items.filter((i) => i.owner_id);
  const doneUnits = owned.reduce((n, it) => n + s.project.deliverable_types.reduce(
    (m, t) => m + (s.done.get(`${it.id}:${t.key}`) ?? 0), 0), 0);
  const v = deadlineView(s.project, owned.length * per, doneUnits, localDate());
  const unowned = s.items.length - owned.length;
  await ctx.reply(
    `<b>${esc(s.project.name)}</b>\nDeadline: ${s.project.deadline}\n` +
      (v.overdue ? `⚠ Deadline passed. ${v.remainingUnits} units still open.` :
        `${v.daysLeft} days left · ${v.remainingUnits} units open · need <b>${v.perDay}/day</b> as a team`) +
      (unowned ? `\n${unowned} qualifications have no owner yet.` : ""),
    { parse_mode: "HTML" },
  );
});
