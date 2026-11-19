import { test } from "node:test";
import assert from "node:assert/strict";
import { overBudget, stripThinking, llmEnabled, complete } from "../src/ai/llm.js";
import { htmlToText } from "../src/ai/summary.js";
import { buildTrackerContext, displayNames } from "../src/ai/ask.js";
import { NCVET_DELIVERABLES } from "../src/modules/tracker/logic.js";

test("displayNames uses first names unless two people share one", () => {
  const m = displayNames([{ id: "a", name: "Asha Rao" }, { id: "b", name: "Asha Iyer" }, { id: "c", name: "Ravi Kumar" }]);
  assert.equal(m.get("a"), "Asha Rao");
  assert.equal(m.get("b"), "Asha Iyer");
  assert.equal(m.get("c"), "Ravi");
});

test("tracker context has deadline, per-person rows and sector owners, and no ids", () => {
  const ctx = buildTrackerContext({
    project: { name: "NCVET", start_date: "2026-11-01", deadline: "2026-11-30", deliverable_types: NCVET_DELIVERABLES, min_pick_quals: 36, max_sectors: 4 },
    items: [
      { id: "i1", sector: "Retail", title: "Q1", owner_id: "p1" },
      { id: "i2", sector: "Agri", title: "Q2", owner_id: null },
    ],
    subs: [{ item_id: "i1", deliverable: "qfile", qty: 1, at: "" }],
    people: [{ id: "p1", name: "Asha Rao", role: "member" }],
    picks: [{ sector: "Retail", person_id: "p1" }],
    todayLogs: [{ by_person: "p1", qty: 1 }],
    today: "2026-11-15",
  });
  assert.match(ctx, /16 days left including today/);
  assert.match(ctx, /Asha \| member \| Retail \| 1 \| 1\/16 \| 8 \| -7 \| 1/);
  assert.match(ctx, /Retail \| 1 \| Asha/);
  assert.match(ctx, /Agri \| 1 \| unowned/);
  assert.match(ctx, /1 without an owner/);
  assert.ok(!ctx.includes("p1") && !ctx.includes("i1"));
});

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
