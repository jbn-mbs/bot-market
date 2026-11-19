/** Escape text for Telegram HTML parse mode (quotes too, so it is safe inside href="…"). */
export function esc(s: unknown): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Short stable hash (FNV-1a, 8 hex chars) for putting long names into 64-byte callback data. */
export function shortHash(s: string): string {
  let h = 0x811c9dc5;
  for (const ch of new TextEncoder().encode(s)) h = Math.imul(h ^ ch, 0x01000193) >>> 0;
  return h.toString(16).padStart(8, "0");
}

/** Monospace table for Telegram (<pre>). */
export function table(headers: string[], rows: (string | number)[][]): string {
  const all = [headers, ...rows.map((r) => r.map(String))];
  const widths = headers.map((_, i) => Math.max(...all.map((r) => (r[i] ?? "").length)));
  const line = (r: string[]) => r.map((c, i) => (c ?? "").padEnd(widths[i])).join("  ").trimEnd();
  return `<pre>${esc([line(all[0]), widths.map((w) => "-".repeat(w)).join("  "), ...all.slice(1).map(line)].join("\n"))}</pre>`;
}

export const signed = (n: number) => (n > 0 ? `+${n}` : String(n));
