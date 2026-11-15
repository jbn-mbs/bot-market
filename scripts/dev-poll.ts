/** Local development: long polling instead of a webhook. Run `npm run dev:poll`. */
import "dotenv/config";
import { createOpsBot } from "../src/bots/ops.js";

const bot = createOpsBot();
await bot.api.deleteWebhook();
console.log("Polling… (Ctrl+C to stop). Re-run set-webhook afterwards for production.");
await bot.start();
