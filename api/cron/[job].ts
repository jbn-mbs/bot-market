import { Api } from "grammy";
import { config } from "../../src/config.js";
import { audit } from "../../src/core/audit.js";
import { recordAndAlert, runHealth, runSeedAudit, runSmoke } from "../../src/modules/devmon/checks.js";
import { countdown, eveningNudge, morningDm, weeklyReport } from "../../src/modules/tracker/jobs.js";
import { dailyDigest, sendToFounders, weeklyDigest } from "../../src/modules/digest/digest.js";

const JOBS: Record<string, (api: Api) => Promise<unknown>> = {
  health: async (api) => recordAndAlert(api, await runHealth()),
  smoke: async (api) => recordAndAlert(api, await runSmoke()),
  "seed-audit": async (api) => recordAndAlert(api, await runSeedAudit()),
  morning: morningDm,
  nudge: eveningNudge,
  "weekly-report": weeklyReport,
  countdown,
  "digest-daily": async (api) => sendToFounders(api, await dailyDigest()),
  "digest-weekly": async (api) => sendToFounders(api, await weeklyDigest()),
};

/** Vercel Cron calls GET with Authorization: Bearer $CRON_SECRET. */
export async function GET(req: Request) {
  if (req.headers.get("authorization") !== `Bearer ${config.cronSecret}`) {
    return new Response("unauthorized", { status: 401 });
  }
  const job = new URL(req.url).pathname.split("/").pop() ?? "";
  const run = JOBS[job];
  if (!run) return new Response("unknown job", { status: 404 });
  try {
    const result = await run(new Api(config.opsBotToken));
    // Health runs every 5 minutes; keep the audit log for jobs that act on people.
    if (!["health", "smoke"].includes(job)) await audit(`cron:${job}`, "cron.run", undefined, result);
    return Response.json({ job, result });
  } catch (e) {
    console.error(`cron ${job} failed`, e);
    return Response.json({ job, error: "failed" }, { status: 500 });
  }
}
