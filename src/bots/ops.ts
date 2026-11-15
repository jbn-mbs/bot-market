import { Bot, session } from "grammy";
import { config } from "../config.js";
import { identify, issueLinkCode, redeemCode, requireRole } from "../core/auth.js";
import { supabaseStorage, type BotContext, type Role } from "../core/context.js";
import { esc } from "../core/format.js";
import { audit } from "../core/audit.js";
import { db, must } from "../db.js";
import { tracker } from "../modules/tracker/commands.js";
import { devmon } from "../modules/devmon/commands.js";
import { dailyDigest, weeklyDigest } from "../modules/digest/digest.js";

/** Commands shown in the Telegram menu, per role. */
const MENU: Record<string, { command: string; description: string }[]> = {
  member: [
    { command: "mytasks", description: "My open qualifications and deliverables" },
    { command: "done", description: "Log a submission" },
    { command: "sectors", description: "Pick my sectors" },
    { command: "status", description: "Team status and deficits" },
    { command: "deadline", description: "Days left and run-rate" },
    { command: "help", description: "What I can do" },
  ],
  dev: [
    { command: "health", description: "Status of every check" },
    { command: "deploys", description: "Last 5 deploys" },
    { command: "bug", description: "Report a bug to GitHub" },
    { command: "uat", description: "Latest UAT results" },
    { command: "uatlog", description: "Record a UAT run" },
  ],
  founder: [
    { command: "digest", description: "Today's digest now" },
    { command: "weekly", description: "This week's digest now" },
    { command: "invite", description: "Create a link code for someone" },
  ],
};

function menuFor(role: Role) {
  const base = [...MENU.member];
  if (role === "dev") base.push(...MENU.dev);
  if (role === "founder" || role === "admin") base.push(...MENU.dev, ...MENU.founder);
  return base;
}

export function createOpsBot(token = config.opsBotToken) {
  const bot = new Bot<BotContext>(token);

  bot.use(session({ initial: () => ({}), storage: supabaseStorage, getSessionKey: (ctx) => ctx.from && ctx.chat ? `ops:${ctx.chat.id}:${ctx.from.id}` : undefined }));
  bot.use(identify);

  bot.command("start", async (ctx) => {
    const code = ctx.match.trim();
    if (ctx.person && !code) return ctx.reply(`Hi ${ctx.person.name.split(" ")[0]}, you're already linked as ${ctx.person.role}. Try /help.`);
    if (!code) return; // identify() already sent the "unknown user" line
    const person = await redeemCode(code, ctx.from!, ctx.chat.id);
    if (!person) return ctx.reply("That code is invalid, expired or already used. Ask your admin for a new one.");
    await ctx.api.setMyCommands(menuFor(person.role), { scope: { type: "chat", chat_id: ctx.chat.id } });
    await ctx.reply(`✅ Linked. Welcome, ${person.name}! You're set up as <b>${person.role}</b>.\nTap the menu button or send /help.`, { parse_mode: "HTML" });
  });

  bot.command("help", (ctx) =>
    ctx.reply(menuFor(ctx.person!.role).map((c) => `/${c.command}: ${c.description}`).join("\n")));

  bot.command("whoami", (ctx) => ctx.reply(`${ctx.person!.name} · ${ctx.person!.role}`));
  bot.command("chatid", requireRole("admin"), (ctx) => ctx.reply(`Chat ID: ${ctx.chat.id}`));

  // /invite <role> <full name>: admin/founder creates a person and a one-time link code.
  bot.command("invite", requireRole("admin"), async (ctx) => {
    const m = ctx.match.trim().match(/^(member|reviewer|dev|founder|admin)\s+(.+)$/);
    if (!m) return ctx.reply("Usage: /invite <member|reviewer|dev|founder|admin> <full name>");
    if (ctx.chat.type !== "private") return ctx.reply("Please run /invite in a DM so the code isn't posted in a group.");
    const person = (must(await db().from("people").insert({ name: m[2], role: m[1] }).select("id")) as any[])[0];
    const code = await issueLinkCode(person.id);
    await audit(ctx.person!.id, "invite", person.id, { role: m[1] });
    const link = `https://t.me/${ctx.me.username}?start=${code}`;
    await ctx.reply(`Invite for <b>${esc(m[2])}</b> (${m[1]}), valid 72 h:\n<code>${code}</code>\n${esc(link)}`, { parse_mode: "HTML" });
  });

  bot.command("digest", requireRole("founder"), async (ctx) => ctx.reply(await dailyDigest(), { parse_mode: "HTML", link_preview_options: { is_disabled: true } }));
  bot.command("weekly", requireRole("founder"), async (ctx) => ctx.reply(await weeklyDigest(), { parse_mode: "HTML", link_preview_options: { is_disabled: true } }));

  bot.use(tracker);
  bot.use(devmon);
  bot.callbackQuery("noop", (ctx) => ctx.answerCallbackQuery());

  bot.catch(async (err) => {
    console.error("bot error", err.error);
    // Never echo error detail (could contain keys) into a chat.
    await err.ctx.reply("Sorry, something went wrong. The dev team has been notified in the logs.").catch(() => {});
  });

  return bot;
}

export { MENU, menuFor };
