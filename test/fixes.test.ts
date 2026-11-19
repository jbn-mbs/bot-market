import { test } from "node:test";
import assert from "node:assert/strict";
import { esc, shortHash } from "../src/core/format.js";
import { FAIL_THRESHOLD, nextCheckState } from "../src/modules/devmon/checks.js";
import { parseGithubPayload, safeEqual } from "../src/modules/devmon/hooks.js";
import { deadlineView, NCVET_DELIVERABLES, type ProjectLike } from "../src/modules/tracker/logic.js";

test("esc escapes quotes so values are safe inside href attributes", () => {
  assert.equal(esc(`a"b<c>&`), "a&quot;b&lt;c&gt;&amp;");
});

test("shortHash is stable, 8 hex chars, and fits callback data for long names", () => {
  const h = shortHash("Agriculture, Food & Allied Sectors (very long name ".repeat(3));
  assert.match(h, /^[0-9a-f]{8}$/);
  assert.equal(h, shortHash("Agriculture, Food & Allied Sectors (very long name ".repeat(3)));
  assert.notEqual(shortHash("Retail"), shortHash("Retai1"));
  assert.ok(`sc:t:${h}`.length <= 64);
});

test("health alerts only after 2 consecutive failures, then resolve once", () => {
  const t = FAIL_THRESHOLD.health;
  let s = nextCheckState(undefined, false, t);
  assert.equal(s.action, null); // one blip: no alert
  s = nextCheckState(s, true, t);
  assert.deepEqual(s, { consec_fails: 0, alerting: false, action: null }); // blip cleared silently
  s = nextCheckState(s, false, t);
  s = nextCheckState(s, false, t);
  assert.equal(s.action, "open");
  s = nextCheckState(s, false, t);
  assert.equal(s.action, null); // long outage: still one alert
  s = nextCheckState(s, true, t);
  assert.equal(s.action, "resolve");
});

test("smoke and seed alert on the first failure", () => {
  assert.equal(nextCheckState(undefined, false, FAIL_THRESHOLD.seed).action, "open");
  assert.equal(nextCheckState({ consec_fails: 3, alerting: true }, true, FAIL_THRESHOLD.seed).action, "resolve");
});

test("github payload parses as JSON and as form-encoded", () => {
  const obj = { action: "opened", n: 1 };
  assert.deepEqual(parseGithubPayload(JSON.stringify(obj), "application/json"), obj);
  const form = new URLSearchParams({ payload: JSON.stringify(obj) }).toString();
  assert.deepEqual(parseGithubPayload(form, "application/x-www-form-urlencoded"), obj);
  assert.throws(() => parseGithubPayload("x=1", "application/x-www-form-urlencoded"));
});

test("safeEqual compares strings of different lengths without throwing", () => {
  assert.ok(safeEqual("Bearer abc", "Bearer abc"));
  assert.ok(!safeEqual("Bearer ab", "Bearer abc"));
  assert.ok(!safeEqual("", "Bearer abc"));
});

test("countdown and /deadline use the same day count (today included)", () => {
  const p: ProjectLike = { start_date: "2026-11-01", deadline: "2026-11-30", deliverable_types: NCVET_DELIVERABLES, min_pick_quals: 36, max_sectors: 4 };
  assert.equal(deadlineView(p, 0, 0, "2026-11-30").daysLeft, 1); // deadline day
  assert.equal(deadlineView(p, 0, 0, "2026-11-24").daysLeft, 7);
});
