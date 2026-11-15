import { db } from "../db.js";

export async function audit(actor: string, action: string, target?: string, detail?: unknown) {
  const { error } = await db().from("audit_log").insert({ actor, action, target, detail: detail ?? null });
  if (error) console.error("audit_log insert failed", error.message);
}
