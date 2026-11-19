import { db, must } from "../db.js";

/** Nightly housekeeping: drop stale conversation state and expired, unused link codes. */
export async function cleanup(sessionDays = 30) {
  const cutoff = new Date(Date.now() - sessionDays * 86_400_000).toISOString();
  const sessions = must(await db().from("sessions").delete().lt("updated_at", cutoff).select("key")) as unknown[];
  const codes = must(await db().from("link_codes").delete().lt("expires_at", new Date().toISOString()).is("used_at", null).select("code")) as unknown[];
  const cacheCutoff = new Date(Date.now() - 2 * 86_400_000).toISOString();
  const usageCutoff = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
  const cache = must(await db().from("llm_cache").delete().lt("created_at", cacheCutoff).select("key")) as unknown[];
  must(await db().from("llm_usage").delete().lt("day", usageCutoff));
  return { sessions: sessions.length, linkCodes: codes.length, llmCache: cache.length };
}
