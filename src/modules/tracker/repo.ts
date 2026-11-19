import { db, must } from "../../db.js";
import { localDate, localMidnightUtc } from "../../core/time.js";
import type { DeliverableType, ItemLike, ProjectLike, SubmissionLike } from "./logic.js";

export interface Project extends ProjectLike { id: string; name: string }

export async function activeProject(): Promise<Project | null> {
  const { data } = await db().from("projects").select("*").eq("active", true).maybeSingle();
  return (data as Project) ?? null;
}

export async function projectItems(projectId: string): Promise<ItemLike[]> {
  // Paginate: Supabase caps a select at 1000 rows by default.
  const out: ItemLike[] = [];
  for (let from = 0; ; from += 1000) {
    const page = must(await db().from("items").select("id, sector, title, owner_id")
      .eq("project_id", projectId).order("sector").order("title").range(from, from + 999)) as ItemLike[];
    out.push(...page);
    if (page.length < 1000) return out;
  }
}

export async function projectSubmissions(itemIds: string[]): Promise<SubmissionLike[]> {
  const out: SubmissionLike[] = [];
  for (let i = 0; i < itemIds.length; i += 200) {
    const chunk = itemIds.slice(i, i + 200);
    out.push(...(must(await db().from("submissions").select("item_id, deliverable, qty, at").in("item_id", chunk)) as SubmissionLike[]));
  }
  return out;
}

export async function picks(projectId: string) {
  return must(await db().from("sector_picks").select("sector, person_id, qualification_count").eq("project_id", projectId)) as
    { sector: string; person_id: string; qualification_count: number }[];
}

const TRACKER_ROLES = ["member", "reviewer", "dev"];

/**
 * Active people in tracker reports, with their Telegram chat if actively linked: everyone in a
 * tracker role, plus founders/admins who actually own items (they can pick sectors too).
 */
export async function trackerPeople(items: Pick<ItemLike, "owner_id">[] = []) {
  const owners = new Set(items.map((i) => i.owner_id).filter(Boolean));
  const rows = must(await db().from("people")
    .select("id, name, role, tg_users(chat_id, active)")
    .eq("active", true).in("role", [...TRACKER_ROLES, "founder", "admin"])
    .order("name")) as any[];
  return rows
    .filter((r) => TRACKER_ROLES.includes(r.role) || owners.has(r.id))
    .map((r) => {
      const tg = Array.isArray(r.tg_users) ? r.tg_users[0] : r.tg_users;
      return {
        id: r.id as string, name: r.name as string, role: r.role as string,
        chatId: (tg?.active ? tg.chat_id : undefined) as number | undefined,
      };
    });
}

export async function chatIdsForRole(role: string): Promise<number[]> {
  const rows = must(await db().from("tg_users").select("chat_id, active, people!inner(role, active)")
    .eq("active", true).eq("people.role", role).eq("people.active", true)) as any[];
  return rows.map((r) => r.chat_id);
}

/** Submission counts per person for one local day. */
export async function submissionsOnDay(date = localDate()) {
  const from = localMidnightUtc(date).toISOString();
  const to = new Date(localMidnightUtc(date).getTime() + 86_400_000).toISOString();
  return must(await db().from("submissions").select("by_person, qty").gte("at", from).lt("at", to)) as
    { by_person: string; qty: number }[];
}

/** Insert a submission. Returns null if `clientRef` was already used (a duplicate tap). */
export async function logSubmission(s: { itemId: string; deliverable: string; by: string; qty: number; clientRef?: string | null }) {
  const res = await db().from("submissions")
    .insert({ item_id: s.itemId, deliverable: s.deliverable, by_person: s.by, qty: s.qty, client_ref: s.clientRef ?? null })
    .select("id");
  if (res.error?.code === "23505") return null; // unique_violation on client_ref
  return (must(res) as { id: string }[])[0].id;
}

export function deliverableLabel(types: DeliverableType[], key: string) {
  return types.find((t) => t.key === key)?.label ?? key;
}

/** Replace a person's sector picks and move item ownership with them. */
export async function savePicks(projectId: string, personId: string, sectors: { sector: string; count: number }[]) {
  const old = must(await db().from("sector_picks").select("sector").eq("project_id", projectId).eq("person_id", personId)) as { sector: string }[];
  const keep = new Set(sectors.map((s) => s.sector));
  const dropped = old.map((o) => o.sector).filter((s) => !keep.has(s));
  const added = sectors.filter((s) => !old.some((o) => o.sector === s.sector));

  if (added.length) {
    // Primary key (project_id, sector) makes a concurrent grab of the same sector fail here.
    must(await db().from("sector_picks").insert(added.map((s) => ({
      project_id: projectId, person_id: personId, sector: s.sector, qualification_count: s.count,
    }))));
  }
  if (dropped.length) {
    must(await db().from("sector_picks").delete().eq("project_id", projectId).eq("person_id", personId).in("sector", dropped));
    must(await db().from("items").update({ owner_id: null }).eq("project_id", projectId).eq("owner_id", personId).in("sector", dropped));
  }
  if (added.length) {
    // Only claim unowned items: a sector imported with mixed owners keeps the other owners' items.
    must(await db().from("items").update({ owner_id: personId }).eq("project_id", projectId)
      .in("sector", added.map((s) => s.sector)).is("owner_id", null));
  }
  return { added: added.map((s) => s.sector), dropped };
}
