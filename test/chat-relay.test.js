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
