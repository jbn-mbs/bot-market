import { test } from "node:test";
import assert from "node:assert/strict";
import { overBudget, stripThinking, llmEnabled, complete } from "../src/ai/llm.js";

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
