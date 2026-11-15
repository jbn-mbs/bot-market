import { test } from "node:test";
import assert from "node:assert/strict";
import {
  NCVET_DELIVERABLES, deadlineView, doneMap, elapsedFraction, evaluatePick, openDeliverables,
  sectorsFromItems, teamProgress, unitsPerItem, type ItemLike, type ProjectLike,
} from "../src/modules/tracker/logic.js";

const project: ProjectLike = {
  start_date: "2026-11-01", deadline: "2026-11-30", deliverable_types: NCVET_DELIVERABLES, min_pick_quals: 36, max_sectors: 4,
};
const items: ItemLike[] = [
  { id: "i1", sector: "Agriculture", title: "Q1", owner_id: "alice" },
  { id: "i2", sector: "Agriculture", title: "Q2", owner_id: "alice" },
  { id: "i3", sector: "Retail", title: "Q3", owner_id: "bob" },
];

test("7 deliverables, endorsements count 10, so 16 units per qualification", () => {
  assert.equal(NCVET_DELIVERABLES.length, 7);
  assert.equal(unitsPerItem(NCVET_DELIVERABLES), 16);
});

test("endorsement units are capped at the target", () => {
  const d = doneMap(NCVET_DELIVERABLES, [
    { item_id: "i1", deliverable: "endorse", qty: 8, at: "" },
    { item_id: "i1", deliverable: "endorse", qty: 5, at: "" },
  ]);
  assert.equal(d.get("i1:endorse"), 10);
  const open = openDeliverables(items[0], NCVET_DELIVERABLES, d);
  assert.ok(!open.some((o) => o.key === "endorse"));
  assert.equal(open.length, 6);
});

test("elapsed fraction is clamped and counts the current day", () => {
  assert.equal(elapsedFraction(project, "2026-10-01"), 0);
  assert.equal(elapsedFraction(project, "2026-11-15"), 15 / 30);
  assert.equal(elapsedFraction(project, "2027-01-01"), 1);
});

test("team progress: halfway through, alice owes half of 32 units", () => {
  const subs = [
    { item_id: "i1", deliverable: "qfile", qty: 1, at: "" },
    { item_id: "i3", deliverable: "endorse", qty: 10, at: "" },
  ];
  const [a, b] = teamProgress(project, items, subs, "2026-11-15", ["alice", "bob"]);
  assert.deepEqual(a, { personId: "alice", items: 2, totalUnits: 32, doneUnits: 1, requiredToDate: 16, balance: -15 });
  assert.equal(b.requiredToDate, 8);
  assert.equal(b.balance, 2);
});

test("sector picks: max sectors, taken sectors and the 36-qualification minimum", () => {
  const many: ItemLike[] = [
    ...Array.from({ length: 20 }, (_, i) => ({ id: `a${i}`, sector: "A", title: `A${i}`, owner_id: null })),
    ...Array.from({ length: 10 }, (_, i) => ({ id: `b${i}`, sector: "B", title: `B${i}`, owner_id: null })),
    ...Array.from({ length: 10 }, (_, i) => ({ id: `c${i}`, sector: "C", title: `C${i}`, owner_id: null })),
    ...Array.from({ length: 3 }, (_, i) => ({ id: `d${i}`, sector: "D", title: `D${i}`, owner_id: null })),
    { id: "e0", sector: "E", title: "E0", owner_id: null },
  ];
  const sectors = sectorsFromItems(many, [{ sector: "C", person_id: "bob" }]);
  assert.deepEqual(evaluatePick(["A", "B"], sectors, "alice", project), { ok: true, total: 30, sufficient: false });
  assert.deepEqual(evaluatePick(["A", "B", "D", "E"], sectors, "alice", project), { ok: true, total: 34, sufficient: false });
  assert.equal((evaluatePick(["A", "C"], sectors, "alice", project) as any).reason, "C is already taken.");
  assert.deepEqual(evaluatePick(["A", "C"], sectors, "bob", project), { ok: true, total: 30, sufficient: false });
  assert.equal(evaluatePick(["A", "B", "C", "D", "E"], sectors, "bob", project).ok, false);
  const big = sectorsFromItems([...many, ...Array.from({ length: 6 }, (_, i) => ({ id: `x${i}`, sector: "B", title: `X${i}`, owner_id: null }))], []);
  assert.deepEqual(evaluatePick(["A", "B"], big, "alice", project), { ok: true, total: 36, sufficient: true });
});

test("deadline run-rate rounds up and flags overdue", () => {
  assert.deepEqual(deadlineView(project, 100, 40, "2026-11-21"), { daysLeft: 10, remainingUnits: 60, overdue: false, perDay: 6 });
  assert.deepEqual(deadlineView(project, 100, 95, "2026-11-30"), { daysLeft: 1, remainingUnits: 5, overdue: false, perDay: 5 });
  assert.equal(deadlineView(project, 100, 95, "2026-12-02").overdue, true);
});
