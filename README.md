# jbn-ops-bots

Telegram bots for JBN management automation, per the design doc *JBN Management Automation Bots on Telegram* (draft v0.1).
This repo currently holds **Phase 0 + Phase 1** of the **JBN Ops** bot:

| Module | What's here |
|---|---|
| Phase 0 | One-time link codes, roles, role-specific command menus, audit log, Supabase-backed conversation state |
| A · Team Tracker | `/mytasks` `/done` `/sectors` `/status` `/deadline`; 09:30 DM, 18:00 nudge, Monday 10:00 deficit report, 7/3/1-day countdown |
| B · Dev & Release Monitor | 5-min health checks, hourly smoke test, nightly + post-deploy seed audit, Vercel deploy + GitHub PR/CI notices; `/health` `/deploys` `/bug` `/uat` `/uatlog` |
| C · Founder Digest | 20:30 daily and Monday 09:00 weekly DM to founders; `/digest` `/weekly` on demand |
| AI assist (optional) | Short AI headline on the digest; `/ask` for plain-language questions about team progress |

The product being monitored is **careerGUIDE** (`../careerGUIDE`, GitHub `Punyamittal/careerGuide`): Express API under `/api/v1`, Next.js frontend on Vercel.

## Stack
Node 20+ · TypeScript · grammY · Vercel serverless functions (webhook mode, `bom1` region) · Vercel Cron · Supabase (`bots` schema, RLS on, service role only).

```
api/telegram/ops.ts    Telegram webhook (secret-token checked)
api/cron/[job].ts      Vercel Cron entry points (Bearer CRON_SECRET)
api/hooks/vercel.ts    Vercel deployment webhook (HMAC-SHA1)
api/hooks/github.ts    GitHub webhook (HMAC-SHA256)
src/core/              auth/linking, roles, sessions, audit, IST time helpers
src/modules/tracker/   A: pure logic (logic.ts, unit-tested), DB access, commands, scheduled jobs
src/modules/devmon/    B: checks, commands, webhook handlers
src/modules/digest/    C: daily/weekly digest
supabase/migrations/   bots schema
scripts/               invite, tracker import, set-webhook, local polling
```

## Setup
1. **BotFather**: create the JBN Ops bot, keep privacy mode on. Put the token in `OPS_BOT_TOKEN`.
2. **Supabase**: run the migrations in order (`001_bots_schema.sql`, `002_fixes.sql`, `003_ai.sql`), then add `bots` under *Settings → API → Exposed schemas*. Bot data should live in an India-region project (DPDP; see design doc §7).
3. **Env**: copy `.env.example` to `.env` (local) and into the Vercel project's environment variables.
4. **Deploy** to Vercel (team jbn7), then `npm run set-webhook -- https://<deployment>`.
   The team must be on **Vercel Pro**: the Hobby plan only allows crons that run once a day, and this project
   needs `health` every 5 minutes and `smoke` hourly.
5. **First admin**: `npm run invite -- founder "Full Name"` prints a code; send `/start <code>` to the bot. After that, invite others from Telegram with `/invite <role> <name>` (in a DM).
6. **Groups**: add the bot to JBN Team and JBN Dev, run `/chatid` in each and set `TEAM_GROUP_ID` / `DEV_GROUP_ID`.
7. **Tracker data**: export the Progress tab to CSV (`sector,title[,owner]`) and run
   `npm run import:tracker -- --file progress.csv --name "<project>" --start YYYY-MM-DD --deadline YYYY-MM-DD`.
8. **Monitor**: create a dedicated MBS test account for `SMOKE_EMAIL`/`SMOKE_PASSWORD`; add a Vercel webhook (deployment events) → `/api/hooks/vercel` and set `VERCEL_PROJECTS` to the careerGUIDE project name(s); add a GitHub webhook (pull requests, workflow runs, issues) on careerGuide → `/api/hooks/github`. Choose content type `application/json` (form-encoded also works).

Bot features that involve files (`/done` attachments, `/bug` screenshots) work in DMs only: with privacy mode on, the bot doesn't see files posted in groups. Bug screenshots are stored in the private bucket and posted to JBN Dev; they are not linked from the GitHub issue.

## AI assist (optional)
Set `LLM_BASE_URL`, `LLM_API_KEY` and `LLM_MODEL` to any OpenAI-compatible API (Groq, OpenRouter, Together, or self-hosted Ollama/vLLM) running an open-source model such as Llama 3.1 8B or Qwen3 32B. Leave `LLM_BASE_URL` empty and every AI feature is off; the bot behaves exactly as before.

- **Digest headline**: 2–3 sentences on what changed and who is behind, above the code-computed numbers.
- **`/ask <question>`**: answers from a text snapshot of the Team Tracker (progress, deadline, sectors, today's logs).

Scope, on purpose: the AI only reads and summarises operations data. It has no tools, can't change data or message anyone, and does no technical work (no bug triage, incident diagnosis or deploy actions). Only first names, sector names and numbers go to the provider.

Cost control: one shared daily token cap (`LLM_DAILY_TOKEN_BUDGET`), a per-person `/ask` limit (`LLM_ASK_PER_DAY`), identical prompts served from a cache (`bots.llm_cache`), and a request timeout (`LLM_TIMEOUT_MS`) after which the bot carries on without AI. Usage is logged per day, person and feature in `bots.llm_usage`.

Local development: `npm run dev:poll` (long polling; removes the webhook, so re-run `set-webhook` afterwards).

## Assumptions to confirm (see design doc §10)
- **"Required" in `/status`** is a straight-line plan: by day *d* of *N*, a person should have done *d/N* of their units (each qualification = 16 units: 6 deliverables + 10 endorsements). Change this in `teamProgress()` if the sheet uses a different rule.
- An **insufficient** sector pick (under 36 qualifications) can still be saved, with the label shown, because the last person to pick may not be able to reach 36.
- Tracker data lives in Supabase and the Google Sheet is imported once. Live two-way Sheet sync isn't built yet.
- Health checks need **2 failures in a row** (10 minutes) before alerting; smoke and seed checks alert on the first failure.
- The 7/3/1-day countdown counts today, like `/deadline`: "1 day left" means the deadline is today.
- Health probes send **unauthenticated** POSTs to `/ai/chat`, Negotiation V2 and the clarification endpoints and expect a non-5xx (usually 401). That shows the route is up without creating sessions or spending AI credits.
- The seed audit is the API version of `backend/scripts/audit-assessment-counts.mjs`. It reads `missingIds` from `GET /assessment/user-flows/:flow`.

## Scripts
`npm test` · `npm run typecheck` · `npm run invite` · `npm run import:tracker` · `npm run set-webhook` · `npm run dev:poll`
