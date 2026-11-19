import { Composer } from "grammy";
import type { BotContext } from "../../core/context.js";
import { audit } from "../../core/audit.js";
import { localDate } from "../../core/time.js";
import { config } from "../../config.js";
import { complete, llmEnabled, usageToday } from "../../ai/llm.js";
import { ASK_SYSTEM, buildTrackerContext } from "../../ai/ask.js";
import * as repo from "../tracker/repo.js";

export const assistant = new Composer<BotContext>();

// /ask <question>: plain-language questions about team progress. Read-only, advisory.
assistant.command("ask", async (ctx) => {
  const question = ctx.match.trim();
  if (!question) return ctx.reply("Usage: /ask <question>\nExample: /ask who is furthest behind and by how much?");
  if (!llmEnabled()) return ctx.reply("AI answers aren't switched on. Use /status or /deadline.");
  if (question.length > 500) return ctx.reply("Please keep the question under 500 characters.");

  const used = await usageToday({ actor: ctx.person!.id, purpose: "ask" });
  if (config.llmAskPerDay > 0 && used.length >= config.llmAskPerDay) {
    return ctx.reply(`You've used today's ${config.llmAskPerDay} questions. /status and /deadline still work.`);
  }

  const project = await repo.activeProject();
  if (!project) return ctx.reply("No active project yet, so there's nothing to answer from.");
  await ctx.replyWithChatAction("typing").catch(() => {});

  const items = await repo.projectItems(project.id);
  const [subs, people, picks, todayLogs] = await Promise.all([
    repo.projectSubmissions(items.map((i) => i.id)),
    repo.trackerPeople(items),
    repo.picks(project.id),
    repo.submissionsOnDay(),
  ]);
  const context = buildTrackerContext({ project, items, subs, people, picks, todayLogs, today: localDate() });

  const answer = await complete([
    { role: "system", content: ASK_SYSTEM },
    { role: "user", content: `TRACKER DATA:\n${context}\n\nQUESTION from ${ctx.person!.name.split(" ")[0]} (${ctx.person!.role}):\n${question}` },
  ], { purpose: "ask", actor: ctx.person!.id, maxTokens: 350, temperature: 0.1, cacheHours: 1 });

  await audit(ctx.person!.id, "ai.ask", undefined, { chars: question.length, answered: !!answer });
  if (!answer) return ctx.reply("I couldn't get an answer right now. Try /status or /deadline.");
  // Plain text (no parse_mode), so model output can't inject formatting or links.
  await ctx.reply(`${answer.slice(0, 3500)}\n\n— AI answer from tracker data. Exact figures: /status`, {
    link_preview_options: { is_disabled: true },
  });
});
