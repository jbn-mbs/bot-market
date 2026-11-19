function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}`);
  return v;
}
/** Optional env var; unset and empty both fall back (Vercel lets you save blank values). */
const opt = (name: string, fallback = "") => process.env[name]?.trim() || fallback;

/** Read lazily so tests and scripts can import modules without a full env. */
export const config = {
  get opsBotToken() { return req("OPS_BOT_TOKEN"); },
  get webhookSecret() { return req("TELEGRAM_WEBHOOK_SECRET"); },
  get teamGroupId() { return opt("TEAM_GROUP_ID"); },
  get devGroupId() { return opt("DEV_GROUP_ID"); },
  get supabaseUrl() { return req("SUPABASE_URL"); },
  get supabaseKey() { return req("SUPABASE_SERVICE_ROLE_KEY"); },
  get filesBucket() { return opt("FILES_BUCKET", "bot-files"); },
  get cronSecret() { return req("CRON_SECRET"); },
  get mbsApiBase() { return opt("MBS_API_BASE").replace(/\/+$/, ""); },
  get mbsSiteUrl() { return opt("MBS_SITE_URL").replace(/\/+$/, ""); },
  get smokeFlows() { return opt("SMOKE_FLOWS", "user1").split(",").map((s) => s.trim()).filter(Boolean); },
  get mbsSupabaseUrl() { return opt("MBS_SUPABASE_URL"); },
  get mbsSupabaseAnonKey() { return opt("MBS_SUPABASE_ANON_KEY"); },
  get smokeEmail() { return opt("SMOKE_EMAIL"); },
  get smokePassword() { return opt("SMOKE_PASSWORD"); },
  get githubToken() { return opt("GITHUB_TOKEN"); },
  get githubRepo() { return opt("GITHUB_REPO", "Punyamittal/careerGuide"); },
  get githubWebhookSecret() { return opt("GITHUB_WEBHOOK_SECRET"); },
  get vercelWebhookSecret() { return opt("VERCEL_WEBHOOK_SECRET"); },
  /** Vercel project names whose deploys are tracked. Empty = all projects in the team. */
  get vercelProjects() { return opt("VERCEL_PROJECTS").split(",").map((s) => s.trim()).filter(Boolean); },
  get tz() { return opt("TZ_NAME", "Asia/Kolkata"); },
  // AI (any OpenAI-compatible API). Leave LLM_BASE_URL empty to turn every AI feature off.
  get llmBaseUrl() { return opt("LLM_BASE_URL").replace(/\/+$/, ""); },
  get llmApiKey() { return opt("LLM_API_KEY"); },
  get llmModel() { return opt("LLM_MODEL"); },
  get llmDailyTokenBudget() { return Number(opt("LLM_DAILY_TOKEN_BUDGET", "200000")); },
  get llmAskPerDay() { return Number(opt("LLM_ASK_PER_DAY", "20")); },
  get llmTimeoutMs() { return Number(opt("LLM_TIMEOUT_MS", "10000")); },
};
