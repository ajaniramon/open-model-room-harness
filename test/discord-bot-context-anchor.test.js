import assert from "node:assert/strict";
import test from "node:test";
import { ChannelType, Events } from "discord.js";
import { createDiscordBot } from "../src/discord-bot.js";

const BOT = { id: "111111111111111111", tag: "Bot#0001", username: "Bot", bot: true };
const ALICE = { id: "333333333333333333", username: "alice", bot: false };
const BOB = { id: "444444444444444444", username: "bob", bot: false };

function baseConfig(overrides = {}) {
  return {
    ownerUserIds: new Set(),
    ownerUsernames: new Set(),
    blockedUsernames: new Set(),
    allowedChannelIds: new Set(),
    respondToBots: false,
    triggerMode: "mention",
    contextMessages: 10,
    contextTimestamps: false,
    timeZone: "UTC",
    chatProvider: "nanogpt",
    chatModel: "test-model",
    nanoGptModel: "test-model",
    visionModel: "test-vision",
    memoryInjectionMaxItems: 6,
    memoryInjectionMaxChars: 1_200,
    spontaneousEnabled: false,
    xPrefetchEnabled: false,
    webPrefetchEnabled: false,
    webAllowedUserIds: new Set(),
    webAllowedUsernames: new Set(),
    writeAllowedUserIds: new Set(),
    writeAllowedUsernames: new Set(),
    readAllowedUserIds: new Set(),
    readAllowedUsernames: new Set(),
    audioAllowedUserIds: new Set(),
    audioAllowedUsernames: new Set(),
    imageAllowedUserIds: new Set(),
    imageAllowedUsernames: new Set(),
    codexAllowedUserIds: new Set(),
    codexAllowedUsernames: new Set(),
    escalationAllowedUserIds: new Set(),
    escalationAllowedUsernames: new Set(),
    escalationModels: {},
    ...overrides,
  };
}

// A channel whose history is a shared store, like Discord: every posted message,
// including the bot's replies, becomes visible to later fetches.
function createHarness({ honorBefore = true } = {}) {
  const store = [];
  const contexts = [];
  const fetchOptions = [];
  let clock = 1_000;
  let counter = 0;
  const releases = [];

  const record = (author, content) => {
    counter += 1;
    clock += 1_000;
    const item = {
      id: String(counter).padStart(4, "0"),
      content,
      author,
      member: null,
      webhookId: null,
      createdTimestamp: clock,
      attachments: new Map(),
    };
    store.push(item);
    return item;
  };

  const channel = {
    type: ChannelType.GuildText,
    sendTyping: async () => undefined,
    messages: {
      fetch: async (options) => {
        fetchOptions.push(options);
        const visible =
          honorBefore && options.before ? store.filter((item) => item.id < options.before) : store;
        return new Map(visible.slice(-options.limit).map((item) => [item.id, item]));
      },
    },
    send: async (content) => record(BOT, typeof content === "string" ? content : content.content),
  };

  const client = createDiscordBot({
    config: baseConfig(),
    nanoGpt: {
      // The first turn stays in flight until the test releases it, so the second
      // mention is admitted while the first is still generating.
      complete: async (context) => {
        contexts.push(context);
        if (contexts.length === 1) await new Promise((resolve) => releases.push(resolve));
        return `reply ${contexts.length}`;
      },
    },
    systemPrompt: "system",
    logger: { info: () => undefined, error: () => undefined },
  });
  client.user = BOT;

  const emit = (author, content) => {
    const item = record(author, content);
    client.emit(Events.MessageCreate, {
      ...item,
      channelId: "channel-a",
      guildId: "GUILD",
      mentions: { has: () => content.includes("@bot") },
      reference: null,
      channel,
      reply: async (payload) => record(BOT, typeof payload === "string" ? payload : payload.content),
    });
    return item;
  };
  const settle = async (ticks = 8) => {
    for (let index = 0; index < ticks; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  const release = () => releases.shift()?.();
  return { contexts, fetchOptions, store, emit, settle, release };
}

async function runQueuedRace(harness) {
  harness.emit(ALICE, "@bot first question");
  await harness.settle();
  const second = harness.emit(BOB, "@bot second question");
  await harness.settle();
  // The bot's first reply lands while the second turn is still queued.
  harness.release();
  await harness.settle();
  return second;
}

test("a queued turn's prompt ends on its own trigger, not on the bot's newer reply", async () => {
  const harness = createHarness();
  const second = await runQueuedRace(harness);

  assert.equal(harness.contexts.length, 2);
  const context = harness.contexts[1];
  const last = context.at(-1);
  assert.equal(last.role, "user");
  assert.match(last.content, /second question/);
  // The bot's reply to the first turn was posted after the second trigger and must not
  // appear in its history.
  assert.ok(!context.some((entry) => entry.role === "assistant" && /reply 1/.test(entry.content)));
  assert.ok(harness.store.some((item) => item.author.id === BOT.id && /reply 1/.test(item.content)));
  assert.equal(harness.fetchOptions.at(-1).before, second.id);
});

test("history stays anchored even if the transport ignores `before`", async () => {
  const harness = createHarness({ honorBefore: false });
  await runQueuedRace(harness);

  const context = harness.contexts[1];
  assert.equal(context.at(-1).role, "user");
  assert.match(context.at(-1).content, /second question/);
  assert.ok(!context.some((entry) => /reply 1/.test(entry.content)));
  // The trigger appears exactly once.
  assert.equal(context.filter((entry) => /second question/.test(entry.content)).length, 1);
});

test("earlier history, including the bot's own earlier replies, is kept in order", async () => {
  const harness = createHarness();
  harness.emit(ALICE, "@bot first question");
  await harness.settle();
  harness.release();
  await harness.settle();
  harness.emit(BOB, "@bot follow-up");
  await harness.settle();

  const context = harness.contexts[1];
  const turns = context.filter((entry) => /first question|reply 1|follow-up/.test(entry.content));
  assert.deepEqual(
    turns.map((entry) => entry.role),
    ["user", "assistant", "user"],
  );
  assert.match(context.at(-1).content, /follow-up/);
});
