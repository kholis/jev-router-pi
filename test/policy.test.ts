import test from "node:test";
import assert from "node:assert/strict";
import { decide, detectOverride } from "../src/policy.ts";

const ALL = ["air", "core", "pro", "max"];
const sure = (choice) => ({ choice, confidence: 0.95 });
const unsure = (choice) => ({ choice, confidence: 0.3 });
const base = { prompt: "refactor the parser", current: "pro", available: ALL, contextTokens: 0 };

test("follows a confident Jev answer", () => {
  assert.deepEqual(decide({ ...base, jev: sure("max") }), {
    tier: "max",
    reason: "jev",
    changed: true,
  });
});

test("an explicit user override beats Jev", () => {
  const out = decide({ ...base, prompt: "use air to fix this typo", jev: sure("max") });
  assert.equal(out.tier, "air");
  assert.equal(out.reason, "override");
});

test("detectOverride fires on tier names and model ids", () => {
  assert.equal(detectOverride("switch to max"), "max");
  assert.equal(detectOverride("use glm-5.3-flash for this"), "air");
  assert.equal(detectOverride("on the GLM 4.7 model"), "core");
  assert.equal(detectOverride("the max of his career"), null);
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

test("caps a low-confidence upgrade at the safe ceiling", () => {
  const out = decide({ ...base, current: "air", jev: unsure("max") });
  assert.equal(out.tier, "pro");
  assert.equal(out.reason, "low-confidence-capped");
});

test("still allows a confident upgrade to max", () => {
  assert.equal(decide({ ...base, jev: sure("max") }).tier, "max");
});

test("refuses a downgrade once the cache rebuild costs more than it saves", () => {
  const out = decide({ ...base, current: "max", jev: sure("air"), contextTokens: 80000 });
  assert.equal(out.tier, "max");
  assert.match(out.reason, /cache-rebuild/);
});

test("allows the same downgrade early in a conversation", () => {
  assert.equal(decide({ ...base, current: "max", jev: sure("air") }).tier, "air");
});

test("unknown current model (other provider) takes Jev's answer", () => {
  const out = decide({ ...base, current: null, jev: sure("core") });
  assert.equal(out.tier, "core");
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
    available: ["air", "max"],
    jev: sure("core"),
  });
  assert.equal(out.tier, "max");
  assert.match(out.reason, /unavailable/);
});

test("falls back to current when nothing is available", () => {
  const out = decide({ ...base, available: [], jev: sure("core") });
  assert.equal(out.tier, "pro");
  assert.equal(out.changed, false);
  assert.match(out.reason, /unavailable/);
});

test("steps up to a vision tier when the prompt carries images", () => {
  const out = decide({
    ...base,
    current: "air",
    available: ALL,
    visionTiers: ["pro"],
    needsVision: true,
    jev: sure("air"),
  });
  assert.equal(out.tier, "pro");
  assert.match(out.reason, /vision/);
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
