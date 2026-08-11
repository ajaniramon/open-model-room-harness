import assert from "node:assert/strict";
import test from "node:test";
import { ChatRelayQueue } from "../src/chat-relay.js";

function message(overrides = {}) {
  return {
    id: "m1",
    content: "hello relay",
    guildId: "g1",
    guild: { name: "Guild One" },
    channelId: "c1",
    channel: { name: "general" },
    author: { id: "u1", username: "user" },
    member: { displayName: "User" },
    ...overrides,
  };
}

test("queues a Discord turn and submits exactly one reply", async () => {
  const sent = [];
  const queue = new ChatRelayQueue({ enabled: true });
  const id = queue.enqueue({
    message: message(),
    context: [{ role: "user", content: "hello relay" }],
    onReply: async (reply) => sent.push(reply),
  });

  assert.equal(queue.size, 1);
  assert.equal(queue.pending()[0].id, id);
  assert.equal(queue.pending()[0].context, undefined);
  assert.deepEqual({
    guildName: queue.pending()[0].guildName,
    channelName: queue.pending()[0].channelName,
    scope: queue.pending()[0].scope,
    isDM: queue.pending()[0].isDM,
  }, {
    guildName: "Guild One",
    channelName: "general",
    scope: "guild",
    isDM: false,
  });
  assert.equal(queue.get(id).context[0].content, "hello relay");

  assert.deepEqual(await queue.submit(id, "hi back"), {
    ok: true,
    id,
    channelId: "c1",
    messageId: "m1",
  });
  assert.deepEqual(sent, ["hi back"]);
  assert.equal(queue.size, 0);
  assert.equal((await queue.submit(id, "again")).ok, false);
});

test("dismisses and expires relay items", async () => {
  let now = 1_000;
  const dismissed = [];
  const queue = new ChatRelayQueue({ enabled: true, ttlMs: 1_000, now: () => now });
  const first = queue.enqueue({
    message: message({ id: "m1" }),
    context: [],
    onDismiss: async (reason) => dismissed.push(reason),
  });
  assert.equal((await queue.dismiss(first, "skip")).ok, true);
  assert.deepEqual(dismissed, ["skip"]);

  queue.enqueue({
    message: message({ id: "m2" }),
    context: [],
    onDismiss: async (reason) => dismissed.push(reason),
  });
  now = 2_001;
  assert.equal(queue.size, 0);
  assert.deepEqual(dismissed, ["skip", "expired"]);
});

test("expires relay items without requiring a queue poll", async () => {
  const dismissed = [];
  const timers = [];
  const queue = new ChatRelayQueue({
    enabled: true,
    setTimer: (callback) => {
      timers.push(callback);
      return timers.length;
    },
    clearTimer: () => undefined,
  });
  queue.enqueue({
    message: message(),
    context: [],
    onDismiss: async (reason) => dismissed.push(reason),
  });

  timers[0]();
  await Promise.resolve();

  assert.equal(queue.size, 0);
  assert.deepEqual(dismissed, ["expired"]);
});

test("releases evicted relay items", async () => {
  const dismissed = [];
  const queue = new ChatRelayQueue({ enabled: true, maxItems: 1 });
  const first = queue.enqueue({
    message: message({ id: "m1" }),
    context: [],
    onDismiss: async (reason) => dismissed.push(["m1", reason]),
  });
  const second = queue.enqueue({
    message: message({ id: "m2" }),
    context: [],
    onDismiss: async (reason) => dismissed.push(["m2", reason]),
  });

  assert.equal(queue.get(first), null);
  assert.equal(queue.get(second).id, second);
  assert.deepEqual(dismissed, [["m1", "evicted"]]);
});

test("releases a relay reservation when reply delivery fails", async () => {
  const dismissed = [];
  const errors = [];
  const queue = new ChatRelayQueue({
    enabled: true,
    logger: { error: (...args) => errors.push(args) },
  });
  const id = queue.enqueue({
    message: message(),
    context: [],
    onReply: async () => {
      throw new Error("Discord send failed");
    },
    onDismiss: async (reason) => dismissed.push(reason),
  });

  assert.deepEqual(await queue.submit(id, "answer"), {
    ok: false,
    error: "Relay reply could not be delivered.",
  });
  assert.equal(queue.size, 0);
  assert.deepEqual(dismissed, ["reply_failed"]);
  assert.equal(errors.length, 1);
});
