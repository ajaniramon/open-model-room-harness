import assert from "node:assert/strict";
import test from "node:test";
import { SpontaneousGate } from "../src/spontaneous.js";

const baseConfig = {
  spontaneousMinMessages: 3,
  spontaneousMaxMessages: 5,
  spontaneousCooldownMs: 0,
  spontaneousMaxPerHour: 2,
};

test("does not select before the minimum and guarantees selection at the maximum", () => {
  const gate = new SpontaneousGate(baseConfig, { random: () => 0.999, now: () => 10_000 });
  assert.equal(gate.consider("channel"), false);
  assert.equal(gate.consider("channel"), false);
  assert.equal(gate.consider("channel"), false);
  assert.equal(gate.consider("channel"), false);
  assert.equal(gate.consider("channel"), true);
});

test("a normal JJ response resets the human-message counter", () => {
  let now = 10_000;
  const gate = new SpontaneousGate(baseConfig, { random: () => 0, now: () => now });
  gate.consider("channel");
  gate.consider("channel");
  gate.recordResponse("channel");
  now += 1;
  assert.equal(gate.consider("channel"), false);
  assert.equal(gate.consider("channel"), false);
  assert.equal(gate.consider("channel"), true);
});

test("enforces the hourly spontaneous-attempt cap", () => {
  let now = 10_000;
  const config = { ...baseConfig, spontaneousMinMessages: 1, spontaneousMaxMessages: 1 };
  const gate = new SpontaneousGate(config, { random: () => 0, now: () => now });
  assert.equal(gate.consider("channel"), true);
  now += 1;
  assert.equal(gate.consider("channel"), true);
  now += 1;
  assert.equal(gate.consider("channel"), false);
});
