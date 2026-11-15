/**
 * Point the Ops bot at the deployed webhook and set the default command menu.
 *   npm run set-webhook -- https://jbn-ops-bots.vercel.app
 */
import "dotenv/config";
import { Api } from "grammy";
import { MENU } from "../src/bots/ops.js";

const base = process.argv[2]?.replace(/\/+$/, "");
if (!base) { console.error("Usage: npm run set-webhook -- <deployment base URL>"); process.exit(1); }
const api = new Api(process.env.OPS_BOT_TOKEN!);
await api.setWebhook(`${base}/api/telegram/ops`, {
  secret_token: process.env.TELEGRAM_WEBHOOK_SECRET!,
  allowed_updates: ["message", "callback_query"],
  drop_pending_updates: true,
});
// Default menu for everyone; linked users get a role-specific menu on /start.
await api.setMyCommands([{ command: "start", description: "Link your account" }, { command: "help", description: "What I can do" }]);
await api.setMyCommands(MENU.member, { scope: { type: "all_group_chats" } });
console.log("Webhook set:", (await api.getWebhookInfo()).url);
