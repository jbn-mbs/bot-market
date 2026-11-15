import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { config } from "./config.js";

let client: SupabaseClient<any, "bots", any> | null = null;

/** Service-role client scoped to the `bots` schema. Server-side only. */
export function db() {
  if (!client) {
    client = createClient(config.supabaseUrl, config.supabaseKey, {
      db: { schema: "bots" },
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return client;
}

/** Throw on Supabase errors so callers can use plain await. */
export function must<T>(res: { data: T; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message);
  return res.data;
}
