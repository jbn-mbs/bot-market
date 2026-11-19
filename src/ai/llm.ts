/**
 * Minimal client for any OpenAI-compatible chat API (Groq, OpenRouter, Together, or a
 * self-hosted Ollama/vLLM). Built to be cheap and never a bottleneck:
 *  - returns null (callers fall back to plain output) when unconfigured, over budget, slow or failing
 *  - caches identical prompts, so re-running /digest on unchanged data costs nothing
 *  - enforces a daily token budget across the whole bot
 * AI output is advisory text only. Nothing here can take actions.
 */
import { createHash } from "node:crypto";
import { config } from "../config.js";
import { db } from "../db.js";
import { localDate } from "../core/time.js";

export interface ChatMessage { role: "system" | "user" | "assistant"; content: string }

export interface CompleteOptions {
  /** Short label stored with usage, e.g. "digest" or "ask". */
  purpose: string;
  /** Person id (or "system") for per-person limits and the usage log. */
  actor?: string;
  maxTokens?: number;
  temperature?: number;
  /** Reuse an identical answer for this long. 0 disables the cache. */
  cacheHours?: number;
}

export const llmEnabled = () => !!(config.llmBaseUrl && config.llmModel);

/** Reasoning models (Qwen, DeepSeek) may prepend <think>…</think>; never show that to users. */
export function stripThinking(s: string): string {
  return s.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/^[\s\S]*<\/think>/i, "").trim();
}

/** True when today's usage has reached the budget (0 = unlimited). */
export function overBudget(rows: { prompt_tokens: number; completion_tokens: number }[], budget: number): boolean {
  if (budget <= 0) return false;
  return rows.reduce((n, r) => n + r.prompt_tokens + r.completion_tokens, 0) >= budget;
}

function cacheKeyFor(model: string, messages: ChatMessage[], maxTokens: number) {
  return createHash("sha256").update(JSON.stringify([model, maxTokens, messages])).digest("hex");
}

export async function usageToday(filter: { actor?: string; purpose?: string } = {}) {
  let q = db().from("llm_usage").select("prompt_tokens, completion_tokens").eq("day", localDate());
  if (filter.actor) q = q.eq("actor", filter.actor);
  if (filter.purpose) q = q.eq("purpose", filter.purpose);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data ?? []) as { prompt_tokens: number; completion_tokens: number }[];
}

export async function complete(messages: ChatMessage[], opts: CompleteOptions): Promise<string | null> {
  if (!llmEnabled()) return null;
  const model = config.llmModel;
  const maxTokens = opts.maxTokens ?? 300;
  const cacheHours = opts.cacheHours ?? 24;
  const key = cacheKeyFor(model, messages, maxTokens);

  try {
    if (cacheHours > 0) {
      const since = new Date(Date.now() - cacheHours * 3600_000).toISOString();
      const { data } = await db().from("llm_cache").select("value").eq("key", key).gte("created_at", since).maybeSingle();
      if (data?.value) return data.value as string;
    }
    if (overBudget(await usageToday(), config.llmDailyTokenBudget)) {
      console.warn("llm daily token budget reached; skipping", opts.purpose);
      return null;
    }

    const res = await fetch(`${config.llmBaseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(config.llmApiKey ? { authorization: `Bearer ${config.llmApiKey}` } : {}),
      },
      body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature: opts.temperature ?? 0.2 }),
      signal: AbortSignal.timeout(config.llmTimeoutMs),
    });
    if (!res.ok) {
      console.warn("llm HTTP", res.status, opts.purpose);
      return null;
    }
    const body = await res.json();
    const text = stripThinking(String(body?.choices?.[0]?.message?.content ?? ""));

    await db().from("llm_usage").insert({
      day: localDate(), purpose: opts.purpose, actor: opts.actor ?? "system", model,
      prompt_tokens: body?.usage?.prompt_tokens ?? 0, completion_tokens: body?.usage?.completion_tokens ?? 0,
    });
    if (!text) return null;
    if (cacheHours > 0) await db().from("llm_cache").upsert({ key, value: text, created_at: new Date().toISOString() });
    return text;
  } catch (e) {
    // Timeouts, network errors, DB hiccups: the feature degrades, the bot keeps working.
    console.warn("llm call failed", opts.purpose, (e as Error).name, (e as Error).message);
    return null;
  }
}
