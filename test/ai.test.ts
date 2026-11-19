import { test } from "node:test";
import assert from "node:assert/strict";
import { overBudget, stripThinking, llmEnabled, complete } from "../src/ai/llm.js";
import { htmlToText } from "../src/ai/summary.js";

test("htmlToText strips Telegram HTML and unescapes entities", () => {
  const html = `🌙 <b>JBN daily digest</b>\n• [P1] <a href="https://x/1">Login &amp; signup &lt;broken&gt;</a>\n<pre>Name  Done</pre>`;
  assert.equal(htmlToText(html), "🌙 JBN daily digest\n• [P1] Login & signup <broken>\nName  Done");
});

test("stripThinking removes reasoning blocks", () => {
  assert.equal(stripThinking("<think>internal</think>\nAnswer."), "Answer.");
  assert.equal(stripThinking("dangling reasoning</think> Answer."), "Answer.");
  assert.equal(stripThinking("Plain answer"), "Plain answer");
});

test("overBudget sums prompt and completion tokens; 0 means unlimited", () => {
  const rows = [{ prompt_tokens: 600, completion_tokens: 300 }, { prompt_tokens: 100, completion_tokens: 0 }];
  assert.equal(overBudget(rows, 1000), true);
  assert.equal(overBudget(rows, 1001), false);
  assert.equal(overBudget(rows, 0), false);
});

test("AI is off and returns null when LLM_BASE_URL is not set", async () => {
  delete process.env.LLM_BASE_URL;
  assert.equal(llmEnabled(), false);
  assert.equal(await complete([{ role: "user", content: "hi" }], { purpose: "test" }), null);
});
