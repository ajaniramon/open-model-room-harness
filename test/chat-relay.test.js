import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ChatRelayQueue } from "../src/chat-relay.js";
import { fetchRelayImageAttachment, fetchRelayAudioAttachment, fetchRelayTextAttachment } from "../src/chat-relay-attachments.js";

function tinyWav() {
  const bytes = Buffer.alloc(44);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(36, 4);
  bytes.write("WAVE", 8, "ascii");
  bytes.write("fmt ", 12, "ascii");
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8_000, 24);
  bytes.writeUInt32LE(16_000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36, "ascii");
  bytes.writeUInt32LE(0, 40);
  return bytes;
}

function tinyMp3WithPrefix() {
  return Buffer.concat([
    Buffer.from("discord-prefix", "ascii"),
    Buffer.from([0xff, 0xfb, 0x90, 0x64]),
    Buffer.alloc(128),
  ]);
}

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

test("queues bounded text attachment metadata without exposing its Discord URL", () => {
  const queue = new ChatRelayQueue({ enabled: true, maxTextAttachments: 1 });
  const id = queue.enqueue({
    message: message({
      attachments: new Map([
        ["a1", {
          url: "https://cdn.discordapp.com/attachments/channel/message/recipe_for_a_pattern.md",
          name: "recipe_for_a_pattern.md",
          contentType: "text/markdown",
          size: 4096,
        }],
        ["a2", {
          url: "https://cdn.discordapp.com/attachments/channel/message/ignored.txt",
          name: "ignored.txt",
          contentType: "text/plain",
          size: 10,
        }],
      ]),
    }),
    context: [],
  });

  const item = queue.get(id);
  assert.deepEqual(item.textAttachments, [{
    index: 0,
    source: "attachment",
    filename: "recipe_for_a_pattern.md",
    contentType: "text/markdown",
    size: 4096,
  }]);
  assert.equal(JSON.stringify(item).includes("discordapp"), false);
  assert.equal(queue.getTextAttachment(id, 0).url, "https://cdn.discordapp.com/attachments/channel/message/recipe_for_a_pattern.md");
  assert.equal(queue.getTextAttachment(id, 1), null);
  assert.match(item.workerContract.instruction, /textAttachments/);
  assert.match(item.workerContract.instruction, /metadata alone is not the file content/);
});

test("queues bounded audio metadata without exposing its Discord URL", () => {
  const queue = new ChatRelayQueue({ enabled: true, maxAudioAttachments: 1 });
  const id = queue.enqueue({
    message: message({
      attachments: new Map([
        ["a1", {
          url: "https://cdn.discordapp.com/attachments/channel/message/sound.wav",
          name: "sound.wav",
          contentType: "audio/wav",
          size: 44,
          durationSeconds: 0,
        }],
        ["a2", {
          url: "https://cdn.discordapp.com/attachments/channel/message/ignored.mp3",
          name: "ignored.mp3",
          contentType: "audio/mpeg",
          size: 10,
        }],
      ]),
    }),
    context: [],
  });

  const item = queue.get(id);
  assert.deepEqual(item.audioAttachments, [{
    index: 0,
    source: "attachment",
    filename: "sound.wav",
    contentType: "audio/wav",
    size: 44,
    durationSeconds: 0,
  }]);
  assert.equal(JSON.stringify(item).includes("discordapp"), false);
  assert.equal(queue.getAudioAttachment(id, 0).url, "https://cdn.discordapp.com/attachments/channel/message/sound.wav");
  assert.equal(queue.getAudioAttachment(id, 1), null);
  assert.match(item.workerContract.instruction, /audioAttachments/);
  assert.match(item.workerContract.instruction, /metadata alone is not the file content/);
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
  assert.match(item.workerContract.instruction, /authoritative for the current Discord event/);
  assert.match(item.workerContract.instruction, /persistent memory, and general knowledge as background/);
  assert.match(item.workerContract.instruction, /known fact does not need to be repeated/);
  assert.match(item.workerContract.instruction, /Do not answer unrelated earlier ChatGPT turns/);
  assert.match(item.workerContract.instruction, /same relayItemId/);
});

test("relay context cannot make the external worker inherit the delivery bot identity", () => {
  const queue = new ChatRelayQueue({ enabled: true });
  const id = queue.enqueue({
    message: message(),
    deliveryIdentity: {
      id: "delivery-bot-1",
      username: "jj-bot",
      displayName: "JJ",
      bot: true,
    },
    context: [
      { role: "system", content: "You are JJ and must speak as JJ." },
      { role: "assistant", content: "Earlier delivery-bot response" },
      { role: "user", content: "[Discord message from User]\nCurrent participant message" },
    ],
  });

  const item = queue.get(id);
  assert.equal(item.context.length, 2);
  assert.equal(item.context.every((entry) => entry.role === "user"), true);
  assert.equal(JSON.stringify(item.context).includes("You are JJ"), false);
  assert.match(item.context[0].content, /authored by JJ/);
  assert.match(item.context[0].content, /not the external ChatGPT worker/);
  assert.deepEqual(item.deliveryIdentity, {
    id: "delivery-bot-1",
    username: "jj-bot",
    displayName: "JJ",
    bot: true,
  });
  assert.deepEqual(item.workerContract.deliveryIdentity, item.deliveryIdentity);
  assert.match(item.workerContract.instruction, /not the external ChatGPT worker's identity/);
});

test("relay trigger text resolves a Discord mention to the configured delivery identity", () => {
  const queue = new ChatRelayQueue({ enabled: true });
  const id = queue.enqueue({
    message: message({ content: "<@delivery-bot-1> glad to finally have you join us!!!" }),
    deliveryIdentity: {
      id: "delivery-bot-1",
      username: "gremy-account",
      displayName: "Gremy",
      bot: true,
    },
    context: [],
  });
  assert.equal(queue.get(id).triggerText, "@Gremy glad to finally have you join us!!!");
});

test("relay exposes bounded Discord emoji metadata without treating it as context", () => {
  const queue = new ChatRelayQueue({ enabled: true });
  const id = queue.enqueue({
    message: message(),
    context: [{ role: "user", content: "hello" }],
    emojiPalette: [
      " <:gremy:1506032464857010427> ",
      "<a:gremy_move:1536197304376229928>",
      "",
      "x".repeat(121),
    ],
  });

  const item = queue.get(id);
  assert.deepEqual(item.emojiPalette, [
    "<:gremy:1506032464857010427>",
    "<a:gremy_move:1536197304376229928>",
  ]);
  assert.equal(JSON.stringify(item.context).includes("gremy_move"), false);
  assert.match(item.workerContract.instruction, /optional custom emoji strings/);
  assert.match(item.workerContract.instruction, /never as a required signature/);
});

test("load sanitizes model roles from relay items persisted by older versions", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "chat-relay-identity-"));
  const statePath = join(directory, "relay.json");
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(statePath, JSON.stringify({
    items: [{
      id: "relay-old-identity",
      createdAt: new Date(Date.now() - 1_000).toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      status: "pending",
      attempts: 0,
      context: [
        { role: "system", content: "You are JJ." },
        { role: "assistant", content: "Old bot response" },
      ],
      deliveryIdentity: { id: "bot", username: "jj", displayName: "JJ", bot: true },
      imageAttachments: [],
    }],
  }));

  const queue = await new ChatRelayQueue({ enabled: true, statePath }).load();
  const item = queue.get("relay-old-identity");
  assert.equal(item.context.length, 1);
  assert.equal(item.context[0].role, "user");
  assert.equal(item.context[0].content.includes("You are JJ"), false);
  assert.match(item.context[0].content, /authored by JJ/);
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

test("fetches only bounded UTF-8 text attachments from approved Discord hosts", async () => {
  const fetched = [];
  const attachment = await fetchRelayTextAttachment({
    url: "https://cdn.discordapp.com/attachments/channel/message/recipe_for_a_pattern.md",
    filename: "recipe_for_a_pattern.md",
    contentType: "text/markdown",
    size: 12,
  }, {
    maxBytes: 20,
    fetchImplementation: async (url, options) => {
      fetched.push([url, options.redirect]);
      return new Response(Buffer.from("# Soul Core\n"), {
        headers: { "content-type": "text/markdown", "content-length": "12" },
      });
    },
  });
  assert.equal(attachment.text, "# Soul Core\n");
  assert.equal(attachment.mimeType, "text/markdown");
  assert.deepEqual(fetched, [["https://cdn.discordapp.com/attachments/channel/message/recipe_for_a_pattern.md", "error"]]);

  await assert.rejects(
    fetchRelayTextAttachment({
      url: "https://example.com/private.md",
      filename: "private.md",
      contentType: "text/markdown",
    }),
    /approved HTTPS Discord CDN or proxy URL/,
  );
  await assert.rejects(
    fetchRelayTextAttachment({
      url: "https://cdn.discordapp.com/attachments/channel/message/huge.md",
      filename: "huge.md",
      contentType: "text/markdown",
      size: 1025,
    }, { maxBytes: 10 }),
    /exceeds the 1024-byte relay limit/,
  );
});

test("fetches only bounded audio attachments from approved Discord hosts", async () => {
  const bytes = tinyWav();
  const fetched = [];
  const attachment = await fetchRelayAudioAttachment({
    url: "https://cdn.discordapp.com/attachments/channel/message/sound.wav",
    filename: "sound.wav",
    contentType: "audio/wav",
    size: bytes.length,
  }, {
    maxBytes: 100,
    fetchImplementation: async (url, options) => {
      fetched.push([url, options.redirect]);
      return new Response(bytes, {
        headers: { "content-type": "audio/wav", "content-length": String(bytes.length) },
      });
    },
  });
  assert.equal(attachment.data, bytes.toString("base64"));
  assert.equal(attachment.mimeType, "audio/wav");
  assert.equal(attachment.size, bytes.length);
  assert.equal(attachment.durationSeconds, 0);
  assert.equal(attachment.sha256.length, 64);
  assert.deepEqual(fetched, [["https://cdn.discordapp.com/attachments/channel/message/sound.wav", "error"]]);

  await assert.rejects(
    fetchRelayAudioAttachment({
      url: "https://example.com/private.wav",
      filename: "private.wav",
      contentType: "audio/wav",
    }),
    /approved HTTPS Discord CDN or proxy URL/,
  );
  await assert.rejects(
    fetchRelayAudioAttachment({
      url: "https://cdn.discordapp.com/attachments/channel/message/huge.wav",
      filename: "huge.wav",
      contentType: "audio/wav",
      size: 1025,
    }, { maxBytes: 10 }),
    /exceeds the 1024-byte relay limit/,
  );
  await assert.rejects(
    fetchRelayAudioAttachment({
      url: "https://cdn.discordapp.com/attachments/channel/message/fake.mp3",
      filename: "fake.mp3",
      contentType: "audio/mpeg",
    }, {
      fetchImplementation: async () => new Response("not audio", {
        headers: { "content-type": "audio/mpeg" },
      }),
    }),
    /not a supported audio file/,
  );
});

test("accepts real-world MP3 responses with generic CDN content types and prefix bytes", async () => {
  const bytes = tinyMp3WithPrefix();
  const attachment = await fetchRelayAudioAttachment({
    url: "https://cdn.discordapp.com/attachments/channel/message/remix.mp3",
    filename: "ODDKO_-_Disobey_Zardonic_Remix.mp3",
    contentType: "audio/mpeg",
    size: bytes.length,
  }, {
    fetchImplementation: async () => new Response(bytes, {
      headers: { "content-type": "application/octet-stream", "content-length": String(bytes.length) },
    }),
  });

  assert.equal(attachment.data, bytes.toString("base64"));
  assert.equal(attachment.mimeType, "audio/mpeg");
  assert.equal(attachment.size, bytes.length);
  assert.equal(attachment.sha256.length, 64);
  assert.equal(typeof attachment.durationSeconds, "number");
});

test("normalizes legacy MP3 MIME aliases from Discord metadata and fetch responses", async () => {
  const bytes = tinyMp3WithPrefix();
  const attachment = await fetchRelayAudioAttachment({
    url: "https://cdn.discordapp.com/attachments/channel/message/legacy.mp3",
    filename: "legacy.mp3",
    contentType: "audio/mpeg3",
    size: bytes.length,
  }, {
    fetchImplementation: async () => new Response(bytes, {
      headers: { "content-type": "audio/mpeg3", "content-length": String(bytes.length) },
    }),
  });

  assert.equal(attachment.mimeType, "audio/mpeg");
  assert.equal(attachment.size, bytes.length);
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

test("flushes relay backlog while preserving leased work unless requested", async () => {
  const dismissed = [];
  const queue = new ChatRelayQueue({ enabled: true });
  const pendingId = queue.enqueue({
    message: message({ id: "pending" }),
    context: [],
    onDismiss: async (reason) => dismissed.push(["pending", reason]),
  });
  const leasedId = queue.enqueue({
    message: message({ id: "leased" }),
    context: [],
    onDismiss: async (reason) => dismissed.push(["leased", reason]),
  });
  const claimed = await queue.claimById({ id: leasedId, workerId: "worker" });
  assert.equal(claimed.ok, true);

  const first = await queue.flushQueue({ reason: "clear backlog" });
  assert.equal(first.ok, true);
  assert.equal(first.removed, 1);
  assert.equal(first.counts.pending, 1);
  assert.equal(first.counts.leased, 0);
  assert.deepEqual(first.ids, [pendingId]);
  assert.equal(queue.get(pendingId), null);
  assert.equal(queue.get(leasedId).status, "leased");

  const second = await queue.flushQueue({ reason: "clear stuck work", includeLeased: true });
  assert.equal(second.removed, 1);
  assert.equal(second.counts.leased, 1);
  assert.deepEqual(second.ids, [leasedId]);
  assert.equal(queue.size, 0);
  assert.deepEqual(dismissed, [["pending", "clear backlog"], ["leased", "clear stuck work"]]);
});

test("expires relay items without requiring a queue poll", async () => {
  let now = 1_000;
  const dismissed = [];
  const timers = [];
  const queue = new ChatRelayQueue({
    enabled: true,
    ttlMs: 1_000,
    now: () => now,
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

  now = 2_001;
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
    directPendingCount: 0,
    spontaneousPendingCount: 0,
    autonomousPendingCount: 0,
    fastLanePendingCount: 0,
    fastLaneActiveCount: 0,
    leasedCount: 1,
    activeCount: 1,
    pendingKey: "",
    activeKey: id,
    oldestPendingId: null,
    oldestPendingKind: null,
    oldestActiveId: id,
    fastLanePendingKey: "",
    fastLaneActiveKey: "",
    oldestFastLanePendingId: null,
    oldestFastLanePendingKind: null,
    oldestFastLaneActiveId: null,
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

test("peeks without exposing content and atomically claims one exact relay item", async () => {
  const queue = new ChatRelayQueue({ enabled: true });
  const firstId = queue.enqueue({
    message: message({ id: "first", content: "private first message" }),
    context: [{ role: "user", content: "private context" }],
  });
  const secondId = queue.enqueue({ message: message({ id: "second" }), context: [] });

  const peeked = queue.peek();
  assert.equal(peeked.id, firstId);
  assert.equal(peeked.scope, "guild");
  assert.equal(peeked.triggerText, undefined);
  assert.equal(peeked.context, undefined);

  const claimed = await queue.claimById({ id: firstId, workerId: "gremy" });
  assert.equal(claimed.ok, true);
  assert.equal(claimed.status, "claimed");
  assert.equal(claimed.item.id, firstId);
  assert.equal(claimed.item.triggerText, "private first message");

  const raced = await queue.claimById({ id: firstId, workerId: "other-worker" });
  assert.equal(raced.ok, false);
  assert.equal(raced.status, "already_claimed");

  const next = queue.peek();
  assert.equal(next.id, secondId);
  const missing = await queue.claimById({ id: "missing", workerId: "gremy" });
  assert.deepEqual(missing, { ok: false, status: "not_pending", id: "missing" });
});

test("prioritizes owner DMs in bounded bursts without starving ordinary relay work", async () => {
  const queue = new ChatRelayQueue({ enabled: true, ownerPriorityBurst: 2 });
  const ordinaryOne = queue.enqueue({
    message: message({ id: "ordinary-1" }),
    context: [],
  });
  const ownerOne = queue.enqueue({
    message: message({ id: "owner-1", guildId: null, guild: null }),
    context: [],
    priority: 200,
  });
  const ownerTwo = queue.enqueue({
    message: message({ id: "owner-2", guildId: null, guild: null }),
    context: [],
    priority: 200,
  });
  const ownerThree = queue.enqueue({
    message: message({ id: "owner-3", guildId: null, guild: null }),
    context: [],
    priority: 200,
  });

  assert.equal(queue.peek().id, ownerOne);
  assert.equal((await queue.claimById({ id: ownerOne, workerId: "worker" })).ok, true);
  assert.equal(queue.peek().id, ownerTwo);
  assert.equal((await queue.claimById({ id: ownerTwo, workerId: "worker" })).ok, true);
  assert.equal(queue.peek().id, ordinaryOne);
  assert.equal((await queue.claimById({ id: ordinaryOne, workerId: "worker" })).ok, true);
  assert.equal(queue.peek().id, ownerThree);
});

test("gives humans a fastpass while periodically admitting waiting bot work", async () => {
  const queue = new ChatRelayQueue({
    enabled: true,
    ownerPriorityBurst: 2,
    humanPriorityBurst: 4,
  });
  const bot = queue.enqueue({
    message: message({ id: "bot", author: { id: "bot", username: "bot", bot: true } }),
    context: [],
    priority: 0,
  });
  const human = queue.enqueue({
    message: message({ id: "human" }),
    context: [],
    priority: 100,
  });
  const ownerOne = queue.enqueue({
    message: message({ id: "owner-fast-1", guildId: null, guild: null }),
    context: [],
    priority: 200,
  });
  const ownerTwo = queue.enqueue({
    message: message({ id: "owner-fast-2", guildId: null, guild: null }),
    context: [],
    priority: 200,
  });
  const ownerThree = queue.enqueue({
    message: message({ id: "owner-fast-3", guildId: null, guild: null }),
    context: [],
    priority: 200,
  });

  assert.equal(queue.peek().id, ownerOne);
  await queue.claimById({ id: ownerOne, workerId: "worker" });
  assert.equal(queue.peek().id, ownerTwo);
  await queue.claimById({ id: ownerTwo, workerId: "worker" });
  assert.equal(queue.peek().id, human);
  await queue.claimById({ id: human, workerId: "worker" });
  assert.equal(queue.peek().id, ownerThree);
  await queue.claimById({ id: ownerThree, workerId: "worker" });
  assert.equal(queue.peek().id, bot);
});

test("wake status exposes a fast lane only for the configured guild and channel", () => {
  const queue = new ChatRelayQueue({
    enabled: true,
    fastLaneGuildId: "fast-guild",
    fastLaneChannelId: "fast-channel",
  });
  queue.enqueue({ message: message({ id: "ordinary" }), context: [] });
  const fast = queue.enqueue({
    message: message({ id: "fast", guildId: "fast-guild", channelId: "fast-channel" }),
    context: [],
  });
  queue.enqueue({
    message: message({ id: "wrong-channel", guildId: "fast-guild", channelId: "ordinary-channel" }),
    context: [],
  });

  const status = queue.wakeStatus();
  assert.equal(status.fastLanePendingCount, 1);
  assert.equal(status.fastLaneActiveCount, 1);
  assert.equal(status.fastLanePendingKey, fast);
  assert.equal(status.fastLaneActiveKey, fast);
  assert.equal(status.oldestFastLanePendingId, fast);
  assert.equal(status.oldestFastLanePendingKind, "direct");
  assert.equal(status.oldestFastLaneActiveId, fast);
  assert.notEqual(queue.peek()?.id, fast);
});

test("authorizes capabilities only for an active lease created from a configured owner turn", async () => {
  const queue = new ChatRelayQueue({ enabled: true });
  const ownerId = queue.enqueue({
    message: message({
      id: "owner-capability",
      guildId: null,
      guild: null,
      author: { id: "owner-user", username: "owner", bot: false },
    }),
    context: [],
    priority: 200,
    authority: "owner",
  });
  const claimed = await queue.claimById({ id: ownerId, workerId: "worker" });
  const leaseToken = claimed.item.leaseToken;

  assert.equal(
    queue.authorizeOwnerLease(ownerId, leaseToken, new Set(["owner-user"])).authorized,
    true,
  );
  assert.equal(queue.authorizeOwnerLease(ownerId, "wrong", new Set(["owner-user"])).authorized, false);
  assert.equal(queue.authorizeOwnerLease(ownerId, leaseToken, new Set(["someone-else"])).authorized, false);

  const humanId = queue.enqueue({
    message: message({ id: "human-capability" }),
    context: [],
    priority: 100,
  });
  const humanClaim = await queue.claimById({ id: humanId, workerId: "worker" });
  assert.equal(
    queue.authorizeOwnerLease(humanId, humanClaim.item.leaseToken, new Set(["user"])).authorized,
    false,
  );
});

test("owner-only wake status exposes only authenticated owner-priority relay work", async () => {
  const queue = new ChatRelayQueue({ enabled: true, ownerPriorityBurst: 1 });
  queue.enqueue({
    message: message({ id: "ordinary" }),
    context: [],
  });
  const ownerId = queue.enqueue({
    message: message({ id: "owner", guildId: null, guild: null }),
    context: [],
    priority: 200,
  });

  assert.deepEqual(queue.wakeStatus({ ownerOnly: true }), {
    pendingCount: 1,
    directPendingCount: 1,
    spontaneousPendingCount: 0,
    autonomousPendingCount: 0,
    fastLanePendingCount: 0,
    fastLaneActiveCount: 0,
    leasedCount: 0,
    activeCount: 1,
    pendingKey: ownerId,
    activeKey: ownerId,
    oldestPendingId: ownerId,
    oldestPendingKind: "direct",
    oldestActiveId: ownerId,
    fastLanePendingKey: "",
    fastLaneActiveKey: "",
    oldestFastLanePendingId: null,
    oldestFastLanePendingKind: null,
    oldestFastLaneActiveId: null,
  });

  const claimed = await queue.claimById({ id: ownerId, workerId: "owner-worker" });
  assert.equal(claimed.ok, true);
  assert.equal(queue.wakeStatus({ ownerOnly: true }).pendingCount, 0);
  assert.equal(queue.wakeStatus({ ownerOnly: true }).leasedCount, 1);
  assert.equal(queue.wakeStatus().pendingCount, 1);
});

test("persists the owner-priority claim streak across relay restarts", async () => {
  const root = await mkdtemp(join(tmpdir(), "chat-relay-priority-"));
  const statePath = join(root, "relay.json");
  try {
    const first = await new ChatRelayQueue({
      enabled: true,
      statePath,
      ownerPriorityBurst: 1,
    }).load();
    const ordinary = first.enqueue({
      message: message({ id: "ordinary" }),
      context: [],
    });
    const owner = first.enqueue({
      message: message({ id: "owner", guildId: null, guild: null }),
      context: [],
      priority: 200,
    });
    await first.flush();
    assert.equal((await first.claimById({ id: owner, workerId: "worker" })).ok, true);
    await first.flush();

    const recovered = await new ChatRelayQueue({
      enabled: true,
      statePath,
      ownerPriorityBurst: 1,
    }).load();
    assert.equal(recovered.peek().id, ordinary);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("wake status distinguishes spontaneous from direct pending work", () => {
  const queue = new ChatRelayQueue({ enabled: true });
  const spontaneousId = queue.enqueue({
    message: message({ id: "spontaneous-message" }),
    context: [],
    kind: "spontaneous",
    directResponse: false,
    spontaneous: true,
  });
  queue.enqueue({ message: message({ id: "direct-message" }), context: [] });
  assert.deepEqual(queue.wakeStatus(), {
    pendingCount: 2,
    directPendingCount: 1,
    spontaneousPendingCount: 1,
    autonomousPendingCount: 0,
    fastLanePendingCount: 0,
    fastLaneActiveCount: 0,
    leasedCount: 0,
    activeCount: 2,
    pendingKey: `${spontaneousId},${queue.pending()[1].id}`,
    activeKey: `${spontaneousId},${queue.pending()[1].id}`,
    oldestPendingId: spontaneousId,
    oldestPendingKind: "spontaneous",
    oldestActiveId: spontaneousId,
    fastLanePendingKey: "",
    fastLaneActiveKey: "",
    oldestFastLanePendingId: null,
    oldestFastLanePendingKind: null,
    oldestFastLaneActiveId: null,
  });
});

test("wake status routes owner heartbeats as autonomous work", () => {
  const queue = new ChatRelayQueue({ enabled: true });
  const autonomousId = queue.enqueue({
    message: message({ id: "owner-heartbeat" }),
    context: [],
    kind: "owner-heartbeat",
    priority: 200,
  });
  queue.enqueue({ message: message({ id: "direct-message" }), context: [] });

  assert.deepEqual(queue.wakeStatus(), {
    pendingCount: 2,
    directPendingCount: 1,
    spontaneousPendingCount: 0,
    autonomousPendingCount: 1,
    fastLanePendingCount: 0,
    fastLaneActiveCount: 0,
    leasedCount: 0,
    activeCount: 2,
    pendingKey: `${autonomousId},${queue.pending()[1].id}`,
    activeKey: `${autonomousId},${queue.pending()[1].id}`,
    oldestPendingId: autonomousId,
    oldestPendingKind: "autonomous",
    oldestActiveId: autonomousId,
    fastLanePendingKey: "",
    fastLaneActiveKey: "",
    oldestFastLanePendingId: null,
    oldestFastLanePendingKind: null,
    oldestFastLaneActiveId: null,
  });
});

test("claim-time capability grants stay server-side while only an opaque event reference is exposed with the lease", async () => {
  const authorityProvider = {
    ensureRelayAuthority: async () => ({
      status: "ready",
      ingressClass: "discord",
      sourceEventId: "relay:c1:m1",
      runId: "run-1",
      eventId: "event_relay_0001",
      authority: "owner",
      renewalCount: 0,
      grants: { filesystem: { grant: "signed-grant", expiresAt: "2026-08-16T10:05:00.000Z" } },
    }),
  };
  const queue = new ChatRelayQueue({ enabled: true, authorityProvider });
  const id = queue.enqueue({ message: message(), context: [], authority: "owner" });
  assert.equal(queue.get(id).capabilityAuthority, null);

  const claimed = await queue.claimById({ id, workerId: "worker" });
  assert.equal(claimed.item.capabilityAuthority.capabilityEventRef, "event_relay_0001");
  assert.equal(claimed.item.capabilityAuthority.grants, undefined);
  const inspected = queue.get(id);
  assert.equal(inspected.capabilityAuthority.eventId, null);
  assert.equal("grants" in inspected.capabilityAuthority, false);
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

test("a claim and renewal protect work from queue expiry for the full lease", async () => {
  let now = 1_000;
  const timers = [];
  const sent = [];
  const queue = new ChatRelayQueue({
    enabled: true,
    ttlMs: 1_000,
    now: () => now,
    setTimer: (callback) => {
      timers.push(callback);
      return timers.length;
    },
    clearTimer: () => undefined,
  });
  const id = queue.enqueue({
    message: message(),
    context: [],
    onReply: async (reply) => sent.push(reply),
  });
  const originalExpiryTimer = timers[0];
  const claimed = await queue.claim({ workerId: "worker", limit: 1, leaseSeconds: 10 });
  assert.equal(claimed[0].expiresAt, new Date(11_000).toISOString());

  now = 2_001;
  originalExpiryTimer();
  await Promise.resolve();
  assert.equal(queue.get(id).status, "leased");

  now = 5_000;
  const renewed = await queue.renewLease(id, claimed[0].leaseToken, 20);
  assert.equal(renewed.leaseUntil, new Date(25_000).toISOString());
  assert.equal(queue.get(id).expiresAt, new Date(25_000).toISOString());

  now = 20_000;
  assert.equal((await queue.submit(id, "finished", claimed[0].leaseToken)).ok, true);
  assert.deepEqual(sent, ["finished"]);
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
