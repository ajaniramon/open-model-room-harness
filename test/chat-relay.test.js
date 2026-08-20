import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ChatRelayQueue } from "../src/chat-relay.js";
import { fetchRelayImageAttachment } from "../src/chat-relay-attachments.js";

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

test("queues bounded image metadata without exposing its Discord URL", () => {
  const queue = new ChatRelayQueue({
    enabled: true,
    maxImageAttachments: 2,
    maxAttachmentBytes: 2048,
  });
  assert.equal(queue.maxImageAttachments, 2);
  assert.equal(queue.maxAttachmentBytes, 2048);
  const id = queue.enqueue({
    message: message({
      attachments: new Map([
        ["a1", {
          url: "https://cdn.discordapp.com/attachments/channel/message/photo.png",
          name: "photo.png",
          contentType: "image/png",
          size: 1234,
          width: 640,
          height: 480,
        }],
      ]),
      embeds: [{
        thumbnail: {
          url: "https://example.com/untrusted.gif",
          proxyURL: "https://images-ext-1.discordapp.net/external/example/preview.webp",
          width: 320,
          height: 180,
        },
      }],
    }),
    context: [],
  });

  const item = queue.get(id);
  assert.deepEqual(item.imageAttachments, [
    {
      index: 0,
      source: "attachment",
      filename: "photo.png",
      contentType: "image/png",
      size: 1234,
      width: 640,
      height: 480,
    },
    {
      index: 1,
      source: "embed-thumbnail",
      filename: "embed-thumbnail",
      contentType: "image/webp",
      size: null,
      width: 320,
      height: 180,
    },
  ]);
  assert.equal(JSON.stringify(item).includes("discordapp"), false);
  assert.equal(queue.getImageAttachment(id, 0).url, "https://cdn.discordapp.com/attachments/channel/message/photo.png");
  assert.equal(queue.getImageAttachment(id, 2), null);
});

test("binds a worker to one relay item and preserves bounded Discord reply context", () => {
  const queue = new ChatRelayQueue({ enabled: true });
  const id = queue.enqueue({
    message: message(),
    context: [{ role: "user", content: "current Discord context" }],
    replyTo: {
      messageId: "referenced-message",
      channelId: "c1",
      guildId: "g1",
      resolved: true,
      author: {
        id: "bot-1",
        username: "assistant",
        displayName: "Room Assistant",
        bot: true,
      },
      content: "the referenced Discord reply".repeat(100),
      ignored: "not public",
    },
  });

  const item = queue.get(id);
  assert.equal(item.replyTo.content.length, 2_000);
  assert.equal(item.replyTo.ignored, undefined);
  assert.equal(item.workerContract.relayItemId, id);
  assert.equal(item.workerContract.triggerMessageId, "m1");
  assert.match(item.workerContract.instruction, /Ignore unrelated earlier ChatGPT turns/);
  assert.match(item.workerContract.instruction, /same relayItemId/);
});

test("fetches only bounded images from approved Discord hosts", async () => {
  const fetched = [];
  const image = await fetchRelayImageAttachment({
    url: "https://cdn.discordapp.com/attachments/channel/message/photo.png",
    contentType: "image/png",
    size: 4,
  }, {
    maxBytes: 10,
    fetchImplementation: async (url, options) => {
      fetched.push([url, options.redirect]);
      return new Response(Buffer.from([1, 2, 3, 4]), {
        headers: { "content-type": "image/png", "content-length": "4" },
      });
    },
  });
  assert.equal(image.data, "AQIDBA==");
  assert.equal(image.mimeType, "image/png");
  assert.deepEqual(fetched, [["https://cdn.discordapp.com/attachments/channel/message/photo.png", "error"]]);

  await assert.rejects(
    fetchRelayImageAttachment({ url: "https://example.com/private.png", contentType: "image/png" }),
    /approved HTTPS Discord CDN or proxy URL/,
  );
  await assert.rejects(
    fetchRelayImageAttachment({
      url: "https://cdn.discordapp.com/attachments/channel/message/huge.png",
      contentType: "image/png",
      size: 1025,
    }, { maxBytes: 10 }),
    /exceeds the 1024-byte relay limit/,
  );
  await assert.rejects(
    fetchRelayImageAttachment({
      url: "https://cdn.discordapp.com/attachments/channel/message/not-image.png",
      contentType: "image/png",
    }, {
      fetchImplementation: async () => new Response("not an image", {
        headers: { "content-type": "text/html" },
      }),
    }),
    /not a supported image/,
  );
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
    maxAttempts: 1,
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

test("persists pending items and recovers them after a restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "chat-relay-state-"));
  const statePath = join(root, "chat-relay.json");
  try {
    const first = new ChatRelayQueue({ enabled: true, statePath });
    const id = first.enqueue({
      message: message({
        attachments: new Map([["a1", {
          url: "https://cdn.discordapp.com/attachments/channel/message/photo.png",
          name: "photo.png",
          contentType: "image/png",
          size: 4,
        }]]),
      }),
      context: [{ role: "user", content: "hello" }],
    });
    await first.flush();

    const second = await new ChatRelayQueue({ enabled: true, statePath }).load();
    assert.equal(second.pending()[0].id, id);
    assert.equal(second.get(id).context[0].content, "hello");
    assert.equal(second.get(id).imageAttachments[0].filename, "photo.png");
    assert.equal(second.getImageAttachment(id, 0).url.includes("cdn.discordapp.com"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("claims relay items atomically and requires the lease token to complete them", async () => {
  const sent = [];
  const queue = new ChatRelayQueue({ enabled: true });
  const id = queue.enqueue({ message: message(), context: [] });
  const claimed = await queue.claim({ workerId: "scheduled-gremy", limit: 1 });
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].id, id);
  assert.deepEqual(queue.wakeStatus(), {
    pendingCount: 0,
    leasedCount: 1,
    activeCount: 1,
    pendingKey: "",
    activeKey: id,
    oldestPendingId: null,
    oldestActiveId: id,
  });
  assert.equal((await queue.claim({ workerId: "second-worker" })).length, 0);
  assert.deepEqual(await queue.submit(id, "wrong worker", "invalid"), {
    ok: false,
    error: "Relay item is leased by another worker.",
  });
  queue.setDeliveryHandlers({ onReply: async (_item, reply) => sent.push(reply) });
  assert.equal((await queue.submit(id, "answer", claimed[0].leaseToken)).ok, true);
  assert.deepEqual(sent, ["answer"]);
});

test("requeues a claimed item after its lease expires", async () => {
  let now = 1_000;
  const queue = new ChatRelayQueue({ enabled: true, now: () => now });
  queue.enqueue({ message: message(), context: [] });
  const claimed = await queue.claim({ workerId: "worker", leaseSeconds: 10 });
  assert.equal(claimed.length, 1);
  now += 11_000;
  assert.equal(queue.pending().length, 1);
  assert.equal(queue.pending()[0].status, "pending");
  assert.equal(queue.wakeStatus().oldestActiveId, claimed[0].id);
});

test("a stalled worker's repeated claims never burn the delivery budget", async () => {
  const dismissed = [];
  const queue = new ChatRelayQueue({
    enabled: true,
    maxAttempts: 3,
    maxClaims: 4,
    leaseSeconds: 10,
    now: (() => {
      let t = 1_000_000;
      return () => (t += 11_000); // each call advances past the lease so claims re-lease
    })(),
    deliveryHandlers: { onDismiss: (item, reason) => dismissed.push([item.messageId, reason]) },
  });
  const id = queue.enqueue({ message: message(), context: [] });

  // Claim over and over without ever submitting: the lease expires between claims.
  for (let i = 0; i < 4; i += 1) await queue.claim({ workerId: "stalled" });
  // The delivery budget is untouched — a real delivery attempt still has all 3.
  const item = queue.get(id);
  assert.equal(item?.attempts ?? 0, 0, "claims must not increment delivery attempts");

  // The next claim finds it claim-exhausted and dismisses it instead of re-leasing.
  const claimed = await queue.claim({ workerId: "stalled" });
  assert.deepEqual(claimed, []);
  assert.deepEqual(dismissed, [["m1", "claim_exhausted"]]);
});

test("context is filled newest-first so the turns before the trigger survive", async () => {
  // maxContextChars floors at 500; three 300-char turns (900) force truncation.
  const queue = new ChatRelayQueue({ enabled: true, maxContextChars: 500 });
  const id = queue.enqueue({
    message: message(),
    context: [
      { role: "user", content: "A".repeat(300) }, // oldest — should be dropped
      { role: "user", content: "B".repeat(300) },
      { role: "user", content: "C".repeat(300) }, // newest — must be kept
    ],
  });
  const item = queue.get(id);
  const joined = item.context.map((m) => m.content).join("|");
  assert.match(joined, /C{300}/, "the newest turn is present in full");
  assert.doesNotMatch(joined, /A{300}/, "the oldest full turn was clipped or dropped");
  assert.ok(joined.startsWith("A") || joined.startsWith("B"), "chronological order is restored");
  assert.ok(joined.lastIndexOf("C") > joined.indexOf("B"), "newest turn comes last");
  assert.equal(item.contextTruncated, true);
});

test("dedupes a redelivered message id even after the item was delivered", async () => {
  const queue = new ChatRelayQueue({ enabled: true });
  const first = queue.enqueue({ message: message({ id: "dup" }), context: [], onReply: async () => {} });
  await queue.submit(first, "answer");
  assert.equal(queue.size, 0);
  // The gateway redelivers the same event after the item is gone.
  const second = queue.enqueue({ message: message({ id: "dup" }), context: [], onReply: async () => {} });
  assert.equal(second, null, "a recently delivered message id is not re-enqueued");
  assert.equal(queue.size, 0);
});

test("dedupes a redelivery against a leased item across a restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "chat-relay-dup-"));
  const statePath = join(root, "chat-relay.json");
  try {
    const first = new ChatRelayQueue({ enabled: true, statePath });
    const id = first.enqueue({ message: message({ id: "restart-dup" }), context: [] });
    await first.claim({ workerId: "w" }); // now leased
    await first.flush();

    const second = new ChatRelayQueue({ enabled: true, statePath });
    await second.load(); // restores it as pending
    // A redelivery of the same event arrives after restart.
    const again = second.enqueue({ message: message({ id: "restart-dup" }), context: [] });
    assert.equal(again, id, "the redelivery maps to the restored item, not a new one");
    assert.equal(second.size, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
