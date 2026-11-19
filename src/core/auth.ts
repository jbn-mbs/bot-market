import { randomBytes } from "node:crypto";
import type { MiddlewareFn, NextFunction } from "grammy";
import { db, must } from "../db.js";
import { audit } from "./audit.js";
import type { BotContext, Person, Role } from "./context.js";

export const UNKNOWN_REPLY =
  "Hi! This bot is for the JBN team. If you have a link code from your admin, send /start followed by the code.";

/** Codes are short, unambiguous and single-use. */
export function newCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(8);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

export async function issueLinkCode(personId: string, ttlHours = 72): Promise<string> {
  const code = newCode();
  must(await db().from("link_codes").insert({
    code, person_id: personId, expires_at: new Date(Date.now() + ttlHours * 3600_000).toISOString(),
  }));
  return code;
}

export async function personForTelegram(telegramId: number): Promise<Person | null> {
  const { data } = await db()
    .from("tg_users")
    .select("active, people!inner(id, name, role, institution_id, active)")
    .eq("telegram_id", telegramId)
    .maybeSingle();
  const p = (data as any)?.people;
  if (!data?.active || !p?.active) return null;
  return { id: p.id, name: p.name, role: p.role, institution_id: p.institution_id };
}

export type RedeemResult =
  | { ok: true; person: Person | null }
  | { ok: false; reason: "invalid" | "already_linked" };

/** Redeem a code: binds this Telegram account to the person the code was issued for. */
export async function redeemCode(code: string, from: { id: number; username?: string }, chatId: number): Promise<RedeemResult> {
  const { data: lc } = await db().from("link_codes").select("*").eq("code", code.trim().toUpperCase()).maybeSingle();
  if (!lc || lc.used_at || new Date(lc.expires_at) < new Date()) return { ok: false, reason: "invalid" };

  // One Telegram account = one person. Refuse before claiming, so the code isn't burned.
  const { data: existing } = await db().from("tg_users").select("person_id").eq("telegram_id", from.id).maybeSingle();
  if (existing && existing.person_id !== lc.person_id) return { ok: false, reason: "already_linked" };

  // Single-use: claim the code atomically before linking.
  const { data: claimed } = await db()
    .from("link_codes").update({ used_at: new Date().toISOString() })
    .eq("code", lc.code).is("used_at", null).select("code");
  if (!claimed?.length) return { ok: false, reason: "invalid" };

  // The person may be re-linking from a new Telegram account: drop the old binding first.
  must(await db().from("tg_users").delete().eq("person_id", lc.person_id).neq("telegram_id", from.id));
  must(await db().from("tg_users").upsert(
    { telegram_id: from.id, person_id: lc.person_id, chat_id: chatId, username: from.username ?? null, active: true, linked_at: new Date().toISOString() },
    { onConflict: "telegram_id" },
  ));
  await audit(lc.person_id, "link", String(from.id));
  return { ok: true, person: await personForTelegram(from.id) };
}

/**
 * Loads ctx.person for linked users. Unlinked users can only use /start <code>;
 * anything else gets one polite line (and nothing in groups).
 */
export const identify: MiddlewareFn<BotContext> = async (ctx, next) => {
  if (!ctx.from) return;
  ctx.person = (await personForTelegram(ctx.from.id)) ?? undefined;
  if (ctx.person) return next();

  const text = ctx.message?.text ?? "";
  if (ctx.chat?.type === "private" && /^\/start(\s|$)/.test(text)) return next();
  if (ctx.chat?.type === "private") await ctx.reply(UNKNOWN_REPLY);
  // Silent in groups and for callbacks from unknown users.
  if (ctx.callbackQuery) await ctx.answerCallbackQuery();
};

/** Command guard: only these roles (founder and admin always pass). */
export function requireRole(...roles: Role[]) {
  return async (ctx: BotContext, next: NextFunction) => {
    const r = ctx.person?.role;
    if (r && (r === "founder" || r === "admin" || roles.includes(r))) return next();
    if (ctx.callbackQuery) return ctx.answerCallbackQuery({ text: "Not available for your role." });
    return ctx.reply("That command isn't available for your role.");
  };
}

/** Admin-side: unlink deletes the Telegram ID (DPDP: no stale identifiers kept). */
export async function unlinkPerson(personId: string, actor: string) {
  must(await db().from("tg_users").delete().eq("person_id", personId));
  await audit(actor, "unlink", personId);
}
