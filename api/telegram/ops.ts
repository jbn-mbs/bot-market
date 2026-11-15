import { webhookCallback } from "grammy";
import { createOpsBot } from "../../src/bots/ops.js";
import { config } from "../../src/config.js";

const bot = createOpsBot();
// Telegram echoes the secret in X-Telegram-Bot-Api-Secret-Token; grammY rejects calls without it.
const handle = webhookCallback(bot, "std/http", { secretToken: config.webhookSecret, timeoutMilliseconds: 55_000 });

export async function POST(req: Request) {
  return handle(req);
}
