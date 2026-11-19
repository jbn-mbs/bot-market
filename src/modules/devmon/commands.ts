import { Composer, InlineKeyboard } from "grammy";
import type { BotContext } from "../../core/context.js";
import { requireRole } from "../../core/auth.js";
import { esc, table } from "../../core/format.js";
import { audit } from "../../core/audit.js";
import { db, must } from "../../db.js";
import { config } from "../../config.js";

export const devmon = new Composer<BotContext>();
const devOnly = requireRole("dev");

const SEVERITY: Record<string, string> = {
  P0: "P0 · blocker, site or core flow down",
  P1: "P1 · major, a flow is broken",
  P2: "P2 · minor, workaround exists",
  P3: "P3 · cosmetic",
};

// ---------- /health ----------
devmon.command("health", devOnly, async (ctx) => {
  const rows = must(await db().from("checks").select("*").order("kind").order("target")) as any[];
  if (!rows.length) return ctx.reply("No checks have run yet.");
  const icon = (s: string) => (s === "ok" ? "🟢" : s === "fail" ? "🔴" : "⚪");
  const lines = rows.map((r) => {
    const age = r.last_checked_at ? Math.round((Date.now() - Date.parse(r.last_checked_at)) / 60_000) : null;
    return `${icon(r.last_status)} <b>${esc(r.target)}</b>: ${esc(r.last_detail ?? "")}` +
      `${r.last_latency_ms ? ` · ${r.last_latency_ms} ms` : ""}${age != null ? ` · ${age}m ago` : ""}`;
  });
  await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
});

// ---------- /deploys ----------
devmon.command("deploys", devOnly, async (ctx) => {
  const rows = must(await db().from("deploys").select("*").order("updated_at", { ascending: false }).limit(5)) as any[];
  if (!rows.length) return ctx.reply("No deploys recorded yet. Is the Vercel webhook set up?");
  const icon: Record<string, string> = { ready: "✅", failed: "❌", started: "⏳", canceled: "⛔" };
  await ctx.reply(rows.map((d) =>
    `${icon[d.state] ?? "•"} <b>${esc(d.project ?? "")}</b> ${esc(d.target ?? "")} · ${esc(d.branch ?? "")}\n` +
    `   ${esc((d.commit_message ?? "").split("\n")[0].slice(0, 80))}\n   ${new Date(d.updated_at).toLocaleString("en-IN", { timeZone: config.tz })}`,
  ).join("\n"), { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
});

// ---------- /uat and /uatlog ----------
devmon.command("uat", devOnly, async (ctx) => {
  const rows = must(await db().from("uat_runs").select("*").order("at", { ascending: false }).limit(200)) as any[];
  const latest = new Map<string, any>();
  for (const r of rows) if (!latest.has(r.suite)) latest.set(r.suite, r);
  if (!latest.size) return ctx.reply("No UAT runs logged. Record one with /uatlog <suite> <pass> <fail> <blocked>.");
  const list = [...latest.values()];
  const sum = (k: string) => list.reduce((n, r) => n + r[k], 0);
  await ctx.reply(
    table(["Suite", "Pass", "Fail", "Blk", "Date"], [
      ...list.map((r) => [r.suite.slice(0, 14), r.pass, r.fail, r.blocked, r.run_date.slice(5)]),
      ["TOTAL", sum("pass"), sum("fail"), sum("blocked"), ""],
    ]),
    { parse_mode: "HTML" },
  );
});

devmon.command("uatlog", devOnly, async (ctx) => {
  const m = ctx.match.trim().match(/^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)$/);
  if (!m) return ctx.reply("Usage: /uatlog <suite> <pass> <fail> <blocked>\nExample: /uatlog UserFlow1 11 70 6");
  must(await db().from("uat_runs").insert({ suite: m[1], pass: +m[2], fail: +m[3], blocked: +m[4], recorded_by: ctx.person!.id }));
  await audit(ctx.person!.id, "uat.log", m[1]);
  await ctx.reply(`Logged ${m[1]}: ${m[2]} pass · ${m[3]} fail · ${m[4]} blocked.`);
});

// ---------- /bug: title → optional screenshot → severity → GitHub issue ----------
devmon.command("bug", devOnly, async (ctx) => {
  const title = ctx.match.trim();
  if (!title) return ctx.reply("Usage: /bug <one-line description>\nExample: /bug User 3 flow stuck on first question");
  // With privacy mode on, the bot never sees photos posted in groups, so skip that step there.
  if (ctx.chat.type !== "private") {
    ctx.session.pendingBug = { title, step: "await_severity" };
    return ctx.reply("How severe? (To attach a screenshot, report the bug in a DM with me.)", { reply_markup: severityKeyboard() });
  }
  ctx.session.pendingBug = { title, step: "await_photo" };
  await ctx.reply("Send a screenshot now, or tap Skip.", {
    reply_markup: new InlineKeyboard().text("Skip screenshot", "bug:skip").text("Cancel", "bug:cancel"),
  });
});

function severityKeyboard() {
  const kb = new InlineKeyboard();
  for (const [k, v] of Object.entries(SEVERITY)) kb.text(v, `bug:sev:${k}`).row();
  return kb.text("Cancel", "bug:cancel");
}

devmon.on("message:photo", async (ctx, next) => {
  const b = ctx.session.pendingBug;
  if (!b || b.step !== "await_photo") return next();
  b.photoFileId = ctx.message.photo.at(-1)!.file_id;
  b.step = "await_severity";
  await ctx.reply("Got it. How severe?", { reply_markup: severityKeyboard() });
});

devmon.callbackQuery("bug:skip", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!ctx.session.pendingBug) return ctx.editMessageText("No bug in progress.");
  ctx.session.pendingBug.step = "await_severity";
  await ctx.editMessageText("How severe?", { reply_markup: severityKeyboard() });
});

devmon.callbackQuery("bug:cancel", async (ctx) => {
  ctx.session.pendingBug = undefined;
  await ctx.answerCallbackQuery();
  await ctx.editMessageText("Bug report cancelled.");
});

devmon.callbackQuery(/^bug:sev:(P[0-3])$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const b = ctx.session.pendingBug;
  if (!b) return ctx.editMessageText("No bug in progress.");
  if (!config.githubToken) return ctx.editMessageText("GITHUB_TOKEN isn't configured.");
  const sev = ctx.match[1];
  await ctx.editMessageText("Opening issue…");

  // Screenshots stay private: kept in the bot's storage bucket and posted to the dev group,
  // never as a bearer link in the GitHub issue (which may be public and would expire anyway).
  let screenshotPath: string | null = null;
  if (b.photoFileId) {
    try {
      const file = await ctx.api.getFile(b.photoFileId);
      const img = await fetch(`https://api.telegram.org/file/bot${config.opsBotToken}/${file.file_path}`);
      if (!img.ok) throw new Error(`telegram file HTTP ${img.status}`);
      const path = `bugs/${Date.now()}-${ctx.person!.id}.jpg`;
      const { error } = await db().storage.from(config.filesBucket).upload(path, await img.arrayBuffer(), { contentType: "image/jpeg" });
      if (error) throw new Error(error.message);
      screenshotPath = path;
    } catch (e) {
      console.error("bug screenshot upload failed", (e as Error).message);
    }
  }

  let res: Response;
  try {
    res = await fetch(`https://api.github.com/repos/${config.githubRepo}/issues`, {
      method: "POST",
      headers: { authorization: `Bearer ${config.githubToken}`, accept: "application/vnd.github+json", "content-type": "application/json" },
      body: JSON.stringify({
        title: `[${sev}] ${b.title}`,
        body: `Reported via JBN Ops bot by ${ctx.person!.name}.\n\n**Severity:** ${SEVERITY[sev]}` +
          (b.photoFileId ? `\n\n_A screenshot was attached; it is posted in the JBN Dev group and stored privately by the bot._` : ""),
        labels: ["bug", sev],
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    // Keep pendingBug so the reporter can tap a severity again instead of retyping.
    await ctx.editMessageText("Couldn't reach GitHub. Try again:", { reply_markup: severityKeyboard() });
    return;
  }
  ctx.session.pendingBug = undefined;
  if (!res.ok) {
    await ctx.editMessageText(`GitHub refused the issue (HTTP ${res.status}). Check the token's Issues permission.`);
    return;
  }
  const issue = await res.json();
  must(await db().from("bug_reports").insert({
    github_number: issue.number, url: issue.html_url, severity: sev, title: b.title, reported_by: ctx.person!.id,
    screenshot_path: screenshotPath,
  }));
  if (b.photoFileId && config.devGroupId) {
    await ctx.api.sendPhoto(config.devGroupId, b.photoFileId, {
      caption: `🐞 #${issue.number} [${sev}] ${b.title}\n${issue.html_url}`.slice(0, 1024),
    }).catch((e) => console.error("dev group photo failed", e));
  }
  await audit(ctx.person!.id, "bug.open", issue.html_url, { sev });
  await ctx.editMessageText(`🐞 Opened #${issue.number} (${sev}): ${issue.html_url}`, { link_preview_options: { is_disabled: true } });
});
