/**
 * Team Tracker rules, kept pure (no I/O) so they can be unit-tested.
 * Mirrors the NCVET Qualification Development Tracking Sheet:
 *  - a person picks up to `maxSectors` sectors whose qualifications add up to >= `minPickQuals`
 *  - one owner per sector
 *  - each qualification has deliverables; some need more than one unit (Endorsements: 10 per Q-file)
 */
import { daysBetween } from "../../core/time.js";

export interface DeliverableType { key: string; label: string; target: number }

export interface ProjectLike {
  start_date: string;
  deadline: string;
  deliverable_types: DeliverableType[];
  min_pick_quals: number;
  max_sectors: number;
}

export interface ItemLike { id: string; sector: string; title: string; owner_id: string | null }
export interface SubmissionLike { item_id: string; deliverable: string; qty: number; at: string }

/** The 7 deliverables from the tracking sheet. */
export const NCVET_DELIVERABLES: DeliverableType[] = [
  { key: "qfile", label: "Q-File", target: 1 },
  { key: "curriculum", label: "Model Curriculum", target: 1 },
  { key: "career", label: "Career Progressions", target: 1 },
  { key: "market", label: "Market Research", target: 1 },
  { key: "govt", label: "Government Initiatives", target: 1 },
  { key: "sop", label: "Assessment SoPs", target: 1 },
  { key: "endorse", label: "Endorsements", target: 10 },
];

export const unitsPerItem = (types: DeliverableType[]) => types.reduce((s, t) => s + t.target, 0);

/** Units logged per item+deliverable, capped at the deliverable's target. */
export function doneMap(types: DeliverableType[], subs: SubmissionLike[]) {
  const targets = new Map(types.map((t) => [t.key, t.target]));
  const raw = new Map<string, number>();
  for (const s of subs) {
    const k = `${s.item_id}:${s.deliverable}`;
    raw.set(k, (raw.get(k) ?? 0) + s.qty);
  }
  const capped = new Map<string, number>();
  for (const [k, v] of raw) {
    const target = targets.get(k.split(":")[1]) ?? 0;
    capped.set(k, Math.min(v, target));
  }
  return capped;
}

/** Open deliverables for one item: label plus how many units remain. */
export function openDeliverables(item: ItemLike, types: DeliverableType[], done: Map<string, number>) {
  return types
    .map((t) => ({ ...t, done: done.get(`${item.id}:${t.key}`) ?? 0 }))
    .filter((t) => t.done < t.target);
}

/** Fraction of the project's time elapsed by `today`, clamped to [0, 1]. Counts today as worked. */
export function elapsedFraction(p: Pick<ProjectLike, "start_date" | "deadline">, today: string): number {
  const total = daysBetween(p.start_date, p.deadline) + 1;
  if (total <= 0) return 1;
  const elapsed = daysBetween(p.start_date, today) + 1;
  return Math.max(0, Math.min(1, elapsed / total));
}

export interface PersonProgress {
  personId: string;
  items: number;
  totalUnits: number;
  doneUnits: number;
  requiredToDate: number;
  /** done - required. Negative is a deficit, positive a surplus. */
  balance: number;
}

/**
 * "Required to date" is a straight-line plan: a person should have finished the
 * same fraction of their units as the fraction of project time that has passed.
 */
export function teamProgress(
  project: ProjectLike, items: ItemLike[], subs: SubmissionLike[], today: string, personIds: string[],
): PersonProgress[] {
  const types = project.deliverable_types;
  const per = unitsPerItem(types);
  const done = doneMap(types, subs);
  const frac = elapsedFraction(project, today);

  return personIds.map((pid) => {
    const mine = items.filter((i) => i.owner_id === pid);
    const totalUnits = mine.length * per;
    let doneUnits = 0;
    for (const it of mine) for (const t of types) doneUnits += done.get(`${it.id}:${t.key}`) ?? 0;
    const requiredToDate = Math.ceil(totalUnits * frac);
    return { personId: pid, items: mine.length, totalUnits, doneUnits, requiredToDate, balance: doneUnits - requiredToDate };
  });
}

export interface SectorInfo { sector: string; count: number; ownerId: string | null }

export function sectorsFromItems(items: ItemLike[], picks: { sector: string; person_id: string }[]): SectorInfo[] {
  const counts = new Map<string, number>();
  for (const i of items) counts.set(i.sector, (counts.get(i.sector) ?? 0) + 1);
  const owners = new Map(picks.map((p) => [p.sector, p.person_id]));
  return [...counts.entries()]
    .map(([sector, count]) => ({ sector, count, ownerId: owners.get(sector) ?? null }))
    .sort((a, b) => a.sector.localeCompare(b.sector));
}

export type PickVerdict =
  | { ok: true; total: number; sufficient: boolean }
  | { ok: false; reason: string };

/** Validate a draft pick: max sectors, sectors not owned by someone else, and the qualification minimum. */
export function evaluatePick(
  draft: string[], sectors: SectorInfo[], personId: string, p: Pick<ProjectLike, "min_pick_quals" | "max_sectors">,
): PickVerdict {
  if (new Set(draft).size !== draft.length) return { ok: false, reason: "A sector is listed twice." };
  if (draft.length > p.max_sectors) return { ok: false, reason: `Pick at most ${p.max_sectors} sectors.` };
  let total = 0;
  for (const s of draft) {
    const info = sectors.find((x) => x.sector === s);
    if (!info) return { ok: false, reason: `Unknown sector: ${s}` };
    if (info.ownerId && info.ownerId !== personId) return { ok: false, reason: `${s} is already taken.` };
    total += info.count;
  }
  return { ok: true, total, sufficient: total >= p.min_pick_quals };
}

export interface DeadlineView { daysLeft: number; remainingUnits: number; perDay: number; overdue: boolean }

/** Days remaining (including today) and the daily rate needed to finish. */
export function deadlineView(project: ProjectLike, totalUnits: number, doneUnits: number, today: string): DeadlineView {
  const daysLeft = daysBetween(today, project.deadline) + 1;
  const remainingUnits = Math.max(0, totalUnits - doneUnits);
  const overdue = daysLeft <= 0;
  return { daysLeft, remainingUnits, overdue, perDay: overdue ? remainingUnits : Math.ceil(remainingUnits / daysLeft) };
}
