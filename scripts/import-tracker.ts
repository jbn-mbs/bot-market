/**
 * Create the active Team Tracker project from a CSV export of the tracking sheet's
 * Progress tab. Required columns: sector, title. Optional: owner (a person's full name, as in bots.people).
 *
 *   npm run import:tracker -- --file progress.csv --name "NCVET Qualifications" --start 2026-11-17 --deadline 2027-02-15
 *
 * Deactivates any previously active project. Deliverables default to the sheet's 7 (Endorsements = 10 per Q-file).
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { db, must } from "../src/db.js";
import { NCVET_DELIVERABLES } from "../src/modules/tracker/logic.js";

const args = Object.fromEntries(process.argv.slice(2).join(" ").split("--").filter(Boolean).map((a) => {
  const [k, ...v] = a.trim().split(" ");
  return [k, v.join(" ").replace(/^"|"$/g, "")];
}));
for (const k of ["file", "name", "start", "deadline"]) {
  if (!args[k]) { console.error(`Missing --${k}`); process.exit(1); }
}

/** Minimal RFC 4180 CSV parser (quoted fields, escaped quotes, CRLF). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let f = ""; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { f += '"'; i++; } else if (c === '"') q = false; else f += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(f); f = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(f); rows.push(row); row = []; f = ""; }
    else f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim()));
}

const [header, ...body] = parseCsv(readFileSync(args.file, "utf8").replace(/^﻿/, ""));
const col = (n: string) => header.findIndex((h) => h.trim().toLowerCase() === n);
const [si, ti, oi] = [col("sector"), col("title"), col("owner")];
if (si < 0 || ti < 0) { console.error(`CSV needs "sector" and "title" columns. Found: ${header.join(", ")}`); process.exit(1); }

const people = must(await db().from("people").select("id, name")) as { id: string; name: string }[];
const byName = new Map(people.map((p) => [p.name.trim().toLowerCase(), p.id]));

must(await db().from("projects").update({ active: false }).eq("active", true));
const project = (must(await db().from("projects").insert({
  name: args.name, start_date: args.start, deadline: args.deadline, deliverable_types: NCVET_DELIVERABLES, active: true,
}).select("id")) as any[])[0];

const unknownOwners = new Set<string>();
const items = body.map((r) => {
  const owner = oi >= 0 ? r[oi]?.trim() : "";
  const ownerId = owner ? byName.get(owner.toLowerCase()) ?? null : null;
  if (owner && !ownerId) unknownOwners.add(owner);
  return { project_id: project.id, sector: r[si].trim(), title: r[ti].trim(), owner_id: ownerId };
}).filter((i) => i.sector && i.title);

for (let i = 0; i < items.length; i += 500) must(await db().from("items").insert(items.slice(i, i + 500)));

// Sector picks follow item ownership when every item in a sector has the same owner.
const bySector = new Map<string, Set<string | null>>();
for (const it of items) bySector.set(it.sector, (bySector.get(it.sector) ?? new Set()).add(it.owner_id));
const picks = [...bySector.entries()]
  .filter(([, owners]) => owners.size === 1 && [...owners][0])
  .map(([sector, owners]) => ({ project_id: project.id, sector, person_id: [...owners][0]!, qualification_count: items.filter((i) => i.sector === sector).length }));
if (picks.length) must(await db().from("sector_picks").insert(picks));
const mixed = [...bySector.entries()].filter(([, owners]) => owners.size > 1).map(([sector]) => sector);

console.log(`Project "${args.name}": ${items.length} qualifications across ${bySector.size} sectors, ${picks.length} sectors pre-assigned.`);
if (mixed.length) {
  console.warn(`Sectors with more than one owner (no sector pick created; existing owners keep their items, ` +
    `whoever picks the sector only gets the unowned ones): ${mixed.join(", ")}`);
}
if (unknownOwners.size) console.warn(`Owners not found in bots.people (left unassigned): ${[...unknownOwners].join(", ")}`);
