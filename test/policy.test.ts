import test from "node:test";
import assert from "node:assert/strict";
import { decide, detectOverride } from "../src/policy.ts";

const ALL = ["air", "pro"];
const sure = (choice) => ({ choice, confidence: 0.95 });
const unsure = (choice) => ({ choice, confidence: 0.3 });
const base = { prompt: "refactor the parser", current: "pro", available: ALL, contextTokens: 0 };

test("follows a confident Jev answer", () => {
  assert.deepEqual(decide({ ...base, jev: sure("air") }), {
    tier: "air",
    reason: "jev",
    changed: true,
  });
});

test("an explicit user override beats Jev", () => {
  const out = decide({ ...base, prompt: "use air to fix this typo", jev: sure("pro") });
  assert.equal(out.tier, "air");
  assert.equal(out.reason, "override");
});

test("detectOverride fires on tier names and model ids", () => {
  assert.equal(detectOverride("switch to pro"), "pro");
  assert.equal(detectOverride("use glm-5.3-flash for this"), "air");
  assert.equal(detectOverride("the pro of his career"), null);
});

test("keeps the current model when Jev is unreachable", () => {
  const out = decide({ ...base, jev: null });
  assert.equal(out.tier, "pro");
  assert.equal(out.changed, false);
  assert.match(out.reason, /jev-unavailable/);
});

test("ignores a tier name Jev invented", () => {
  assert.equal(decide({ ...base, jev: sure("gpt-9") }).tier, "pro");
});

test("never downgrades on a low-confidence answer", () => {
  const out = decide({ ...base, jev: unsure("air") });
  assert.equal(out.tier, "pro");
  assert.match(out.reason, /low-confidence-no-downgrade/);
});

test("allows a low-confidence upgrade up to the safe ceiling", () => {
  const out = decide({ ...base, current: "air", jev: unsure("pro") });
  assert.equal(out.tier, "pro");
  assert.equal(out.reason, "jev");
});

test("still allows a confident upgrade to pro", () => {
  assert.equal(decide({ ...base, current: "air", jev: sure("pro") }).tier, "pro");
});

test("refuses a downgrade once the cache rebuild costs more than it saves", () => {
  const out = decide({ ...base, current: "pro", jev: sure("air"), contextTokens: 80000 });
  assert.equal(out.tier, "pro");
  assert.match(out.reason, /cache-rebuild/);
});

test("allows the same downgrade early in a conversation", () => {
  assert.equal(decide({ ...base, current: "pro", jev: sure("air") }).tier, "air");
});

test("unknown current model (other provider) takes Jev's answer", () => {
  const out = decide({ ...base, current: null, jev: sure("pro") });
  assert.equal(out.tier, "pro");
  assert.equal(out.changed, true);
});

test("unknown current model never downgrades on low confidence", () => {
  const out = decide({ ...base, current: null, jev: unsure("air") });
  assert.equal(out.tier, "air");
  assert.match(out.reason, /low-confidence-no-downgrade/);
});

test("substitutes upward when the chosen tier is unavailable", () => {
  const out = decide({
    ...base,
    current: "air",
    available: ["pro"],
    jev: sure("air"),
  });
  assert.equal(out.tier, "pro");
  assert.match(out.reason, /unavailable/);
});

test("falls back to current when nothing is available", () => {
  const out = decide({ ...base, available: [], jev: sure("pro") });
  assert.equal(out.tier, "pro");
  assert.equal(out.changed, false);
  assert.match(out.reason, /unavailable/);
});

test("keeps the current model when the chosen tier cannot see images", () => {
  const out = decide({
    ...base,
    current: "pro",
    available: ALL,
    visionTiers: ["air"],
    needsVision: true,
    jev: sure("pro"),
  });
  assert.equal(out.tier, "pro");
  assert.equal(out.changed, false);
  assert.equal(out.reason, "vision-unavailable");
});

test("keeps the current model when no vision tier exists", () => {
  const out = decide({
    ...base,
    current: "pro",
    available: ALL,
    visionTiers: [],
    needsVision: true,
    jev: sure("air"),
  });
  assert.equal(out.tier, "pro");
  assert.equal(out.changed, false);
  assert.equal(out.reason, "vision-unavailable");
});
