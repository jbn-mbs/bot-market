import type { Context, SessionFlavor, StorageAdapter } from "grammy";
import { db } from "../db.js";

export type Role =
  | "member" | "reviewer" | "dev" | "founder" | "admin"
  | "institution_admin" | "account_manager" | "counsellor";

export interface Person {
  id: string;
  name: string;
  role: Role;
  institution_id: string | null;
}

/** Multi-step flows keep their state here between webhook calls. */
export interface SessionData {
  sectorDraft?: string[];
  pendingBug?: { title: string; photoFileId?: string; step: "await_photo" | "await_severity" };
  /** Last logged submission, so a file sent right after can be attached to it. */
  pendingDone?: { submissionId: string; expires: number };
}

export type BotContext = Context & SessionFlavor<SessionData> & { person?: Person };

/** grammY session storage backed by bots.sessions. */
export const supabaseStorage: StorageAdapter<SessionData> = {
  async read(key) {
    const { data } = await db().from("sessions").select("value").eq("key", key).maybeSingle();
    return (data?.value as SessionData) ?? undefined;
  },
  async write(key, value) {
    await db().from("sessions").upsert({ key, value, updated_at: new Date().toISOString() });
  },
  async delete(key) {
    await db().from("sessions").delete().eq("key", key);
  },
};
