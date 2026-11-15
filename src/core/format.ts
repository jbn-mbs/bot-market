/** Escape text for Telegram HTML parse mode. */
export function esc(s: unknown): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Monospace table for Telegram (<pre>). */
export function table(headers: string[], rows: (string | number)[][]): string {
  const all = [headers, ...rows.map((r) => r.map(String))];
  const widths = headers.map((_, i) => Math.max(...all.map((r) => (r[i] ?? "").length)));
  const line = (r: string[]) => r.map((c, i) => (c ?? "").padEnd(widths[i])).join("  ").trimEnd();
  return `<pre>${esc([line(all[0]), widths.map((w) => "-".repeat(w)).join("  "), ...all.slice(1).map(line)].join("\n"))}</pre>`;
}

export const signed = (n: number) => (n > 0 ? `+${n}` : String(n));
