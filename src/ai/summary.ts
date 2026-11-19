/**
 * Short plain-language headline for the founder digest. The numbers in the digest are still
 * computed by code; the model only reads them and says what deserves attention.
 */
import { complete } from "./llm.js";

/** Telegram HTML → plain text, so the model sees the same facts with fewer tokens. */
export function htmlToText(html: string): string {
  return html
    .replace(/<a\s[^>]*>(.*?)<\/a>/gi, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

const SYSTEM = [
  "You write the opening lines of an internal daily/weekly report for the founders of a small company.",
  "Using ONLY the report below, write 2 or 3 short sentences: what changed, what needs attention, and who is behind (if anyone).",
  "Do not invent numbers or names. Do not repeat every figure. No greeting, no headings, no markdown, no emoji.",
].join(" ");

export async function digestHeadline(digestHtml: string): Promise<string | null> {
  const text = await complete(
    [{ role: "system", content: SYSTEM }, { role: "user", content: htmlToText(digestHtml).slice(0, 6000) }],
    // Same data → same prompt → cache hit, so the cron run and a later /digest cost one call.
    { purpose: "digest", maxTokens: 160, temperature: 0.2, cacheHours: 24 },
  );
  return text ? text.replace(/\s+/g, " ").slice(0, 600) : null;
}
