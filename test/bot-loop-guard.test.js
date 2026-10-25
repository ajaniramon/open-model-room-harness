import assert from "node:assert/strict";
import test from "node:test";
import { BotLoopGuard } from "../src/bot-loop-guard.js";

test("allows a bounded bot chain and then cools the channel down", () => {
  let now = 1_000;
  const guard = new BotLoopGuard(
    { enabled: true, maxConsecutive: 3, cooldownSeconds: 60 },
    () => now,
  );

  assert.equal(guard.admitBotTrigger("channel").allowed, true);
  assert.equal(guard.admitBotTrigger("channel").allowed, true);
  const finalAllowed = guard.admitBotTrigger("channel");
  assert.equal(finalAllowed.allowed, true);
  assert.equal(finalAllowed.cooldownUntil, 61_000);
  assert.deepEqual(guard.admitBotTrigger("channel"), {
    allowed: false,
    reason: "bot_loop_cooldown",
    retryAt: 61_000,
  });

  now = 61_000;
  assert.equal(guard.admitBotTrigger("channel").allowed, true);
});

test("a human message immediately resets the channel bot chain", () => {
  const guard = new BotLoopGuard({ maxConsecutive: 2, cooldownSeconds: 60 });
  guard.admitBotTrigger("channel");
  guard.admitBotTrigger("channel");
  assert.equal(guard.admitBotTrigger("channel").allowed, false);

  guard.observeHuman("channel");
  assert.equal(guard.admitBotTrigger("channel").allowed, true);
});

test("tracks channels independently and can be disabled", () => {
  const guard = new BotLoopGuard({ maxConsecutive: 1, cooldownSeconds: 60 });
  assert.equal(guard.admitBotTrigger("one").allowed, true);
  assert.equal(guard.admitBotTrigger("one").allowed, false);
  assert.equal(guard.admitBotTrigger("two").allowed, true);

  const disabled = new BotLoopGuard({ enabled: false, maxConsecutive: 1 });
  assert.equal(disabled.admitBotTrigger("one").allowed, true);
  assert.equal(disabled.admitBotTrigger("one").allowed, true);
});
