import assert from "node:assert/strict";
import test from "node:test";
import { ChannelType, Events } from "discord.js";
import { createDiscordBot } from "../src/discord-bot.js";
import { XPostPrefetcher } from "../src/x-tools.js";

const OWNER = { id: "222222222222222222", username: "owner_identity", bot: false };
const STRANGER = { id: "999999999999999999", username: "stranger", bot: false };

function baseConfig(overrides = {}) {
  return {
    ownerUserIds: new Set([OWNER.id]),
    ownerUsernames: new Set([OWNER.username]),
    blockedUsernames: new Set(),
    allowedChannelIds: new Set(),
    respondToBots: false,
    triggerMode: "mention",
    contextMessages: 5,
    contextTimestamps: false,
    timeZone: "UTC",
    chatProvider: "nanogpt",
    chatModel: "test-model",
    nanoGptModel: "test-model",
    visionModel: "test-vision",
    memoryInjectionMaxItems: 6,
    memoryInjectionMaxChars: 1_200,
    // One non-mention message is enough to select a spontaneous turn.
    spontaneousEnabled: true,
    spontaneousMinChars: 12,
    spontaneousMinMessages: 1,
    spontaneousMaxMessages: 1,
    spontaneousCooldownMs: 0,
    spontaneousMaxPerHour: 2,
    xPrefetchEnabled: true,
    xPrefetchMaxPosts: 2,
    xPrefetchMaxChars: 1_200,
    webAllowedUserIds: new Set(),
    webAllowedUsernames: new Set(),
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

function createHarness({
  config = baseConfig(),
  postText = "A downloaded post",
  visionAnalyzer = null,
  chatRelay = null,
} = {}) {
  const contexts = [];
  const completions = [];
  const fetched = [];
  const client = createDiscordBot({
    config,
    nanoGpt: {
      complete: async (context, options) => {
        contexts.push(context);
        completions.push(options || {});
        return "model answer";
      },
    },
    xPostPrefetcher: new XPostPrefetcher({
      client: {
        async fetchPost(url) {
          fetched.push(url);
          return postText;
        },
      },
      maxPosts: config.xPrefetchMaxPosts,
      maxChars: config.xPrefetchMaxChars,
    }),
    visionAnalyzer,
    chatRelay,
    runtimeControl: {
      maintenanceEnabled: false,
      observationEnabled: false,
      applyPresence: async () => undefined,
      execute: async () => ({ response: "[ok]" }),
    },
    systemPrompt: "system",
    logger: { info: () => undefined, error: () => undefined },
  });
  client.user = { id: "111111111111111111", tag: "Bot#0001" };

  let counter = 0;
  const emit = (author, content, { dm = false, attachments = new Map() } = {}) => {
    counter += 1;
    const index = counter;
    client.emit(Events.MessageCreate, {
      id: `m${index}`,
      content,
      channelId: dm ? "dm-channel" : "channel-a",
      guildId: dm ? null : "GUILD",
      author,
      member: null,
      webhookId: null,
      createdTimestamp: Date.now(),
      attachments,
      mentions: { has: () => content.includes("@bot") },
      reference: null,
      channel: {
        type: dm ? ChannelType.DM : ChannelType.GuildText,
        sendTyping: async () => undefined,
        messages: { fetch: async () => new Map() },
        send: async () => ({ id: `s${index}` }),
      },
      reply: async () => ({ id: `r${index}` }),
    });
  };
  const settle = async (ticks = 8) => {
    for (let index = 0; index < ticks; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  return { contexts, completions, fetched, emit, settle };
}

function userTurn(context) {
  return context.filter((entry) => entry.role === "user").at(-1)?.content || "";
}

test("downloads a linked X post and attaches it to the triggering message", async () => {
  const harness = createHarness();
  harness.emit(STRANGER, "@bot what do you make of this https://x.com/jack/status/20");
  await harness.settle();

  assert.deepEqual(harness.fetched, ["https://x.com/jack/status/20"]);
  const context = harness.contexts.at(-1);
  assert.ok(context, "the model should have been called");
  assert.match(userTurn(context), /Application X\/Twitter post download/);
  assert.match(userTurn(context), /A downloaded post/);
  assert.match(context[0].content, /the application already downloaded them/);
  // The post arrives as context, so no web tool is exposed for a bare link.
  assert.deepEqual(harness.completions.at(-1).enabledToolNames, []);
});

test("downloads a linked X post on a spontaneous turn", async () => {
  const harness = createHarness();
  harness.emit(STRANGER, "everyone look at this post https://x.com/jack/status/20");
  await harness.settle();

  assert.deepEqual(harness.fetched, ["https://x.com/jack/status/20"]);
  assert.match(userTurn(harness.contexts.at(-1)), /A downloaded post/);
});

test("ignores links in direct messages from anyone but the owner", async () => {
  const harness = createHarness();
  harness.emit(STRANGER, "look at this https://x.com/jack/status/20", { dm: true });
  await harness.settle();

  assert.deepEqual(harness.fetched, []);
  assert.doesNotMatch(userTurn(harness.contexts.at(-1)), /post download/);

  harness.emit(OWNER, "look at this https://x.com/jack/status/20", { dm: true });
  await harness.settle();
  assert.deepEqual(harness.fetched, ["https://x.com/jack/status/20"]);
});

test("leaves messages without an X link untouched", async () => {
  const harness = createHarness();
  harness.emit(STRANGER, "@bot tell me a joke about https://example.com/status/20");
  await harness.settle();

  assert.deepEqual(harness.fetched, []);
  const context = harness.contexts.at(-1);
  assert.doesNotMatch(userTurn(context), /post download/);
  assert.doesNotMatch(context[0].content, /already downloaded/);
});

test("says the post could not be opened when the download fails", async () => {
  const harness = createHarness({ postText: "ERROR: FxTwitter returned 404: not found" });
  harness.emit(STRANGER, "@bot https://x.com/jack/status/20");
  await harness.settle();

  const context = harness.contexts.at(-1);
  assert.match(userTurn(context), /not downloaded: FxTwitter returned 404: not found/);
  assert.match(context[0].content, /say you could not open it/);
});

test("a disabled prefetch gate downloads nothing", async () => {
  const harness = createHarness({ config: baseConfig({ xPrefetchEnabled: false }) });
  harness.emit(STRANGER, "@bot https://x.com/jack/status/20");
  await harness.settle();

  assert.deepEqual(harness.fetched, []);
  assert.doesNotMatch(userTurn(harness.contexts.at(-1)), /post download/);
});

test("provider-free relay mode preserves images without running local vision", async () => {
  let visionCalls = 0;
  let queuedMessage = null;
  const chatRelay = {
    enabled: true,
    setDeliveryHandlers: () => undefined,
    enqueue({ message }) {
      queuedMessage = message;
      return "relay-image";
    },
  };
  const attachments = new Map([
    ["image", {
      url: "https://cdn.discordapp.com/attachments/channel/message/photo.png",
      name: "photo.png",
      contentType: "image/png",
    }],
  ]);
  const harness = createHarness({
    config: baseConfig({ chatProvider: "none", chatModel: "none" }),
    chatRelay,
    visionAnalyzer: {
      async analyze() {
        visionCalls += 1;
        return "local image description";
      },
    },
  });

  harness.emit(STRANGER, "@bot what is in this image?", { attachments });
  await harness.settle();

  assert.equal(visionCalls, 0);
  assert.equal(queuedMessage?.attachments, attachments);
});
