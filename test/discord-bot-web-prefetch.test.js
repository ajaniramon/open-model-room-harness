import assert from "node:assert/strict";
import test from "node:test";
import { ChannelType, Events } from "discord.js";
import { createDiscordBot } from "../src/discord-bot.js";
import { WebPagePrefetcher } from "../src/web-tools.js";

const OWNER = { id: "222222222222222222", username: "owner_identity", bot: false };
const WEB_USER = { id: "333333333333333333", username: "web_authorized", bot: false };
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
    spontaneousEnabled: false,
    xPrefetchEnabled: false,
    webPrefetchEnabled: true,
    webPrefetchMaxUrls: 2,
    webPrefetchMaxChars: 3_000,
    webAllowedUserIds: new Set([WEB_USER.id]),
    webAllowedUsernames: new Set([WEB_USER.username]),
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
  pageText = "Commit 33df0e6: fixes duplicate turns and retry drift.",
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
    webPagePrefetcher: new WebPagePrefetcher({
      client: {
        async fetchUrl(url) {
          fetched.push(url);
          return pageText;
        },
      },
      maxUrls: config.webPrefetchMaxUrls,
      maxChars: config.webPrefetchMaxChars,
      // GitHub-style plain-text endpoints never reach the network in tests.
      fetchImplementation: async (url) => {
        fetched.push(url);
        return new Response(pageText, { status: 200 });
      },
    }),
    systemPrompt: "system",
    logger: { info: () => undefined, error: () => undefined },
  });
  client.user = { id: "111111111111111111", tag: "Bot#0001" };

  let counter = 0;
  const emit = (author, content, { dm = false } = {}) => {
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
      attachments: new Map(),
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

test("downloads a bare link from a web-authorized identity and attaches the page", async () => {
  const harness = createHarness();
  const url = "https://github.com/ajaniramon/open-model-room-harness/commit/33df0e6ce9801e04866653cb93791f191ef269cc";
  harness.emit(WEB_USER, `@bot ${url}`);
  await harness.settle();

  // A GitHub commit link is rewritten to its plain-text .patch endpoint.
  assert.deepEqual(harness.fetched, [`${url}.patch`]);
  const context = harness.contexts.at(-1);
  assert.ok(context, "the model should have been called");
  assert.match(userTurn(context), /Application web page download/);
  assert.match(userTurn(context), /fixes duplicate turns/);
  assert.match(context[0].content, /already downloaded their readable text/);
  // The page arrives as context; a bare link still exposes no web tools.
  assert.deepEqual(harness.completions.at(-1).enabledToolNames, []);
});

test("a stranger's bare link is never downloaded", async () => {
  const harness = createHarness();
  harness.emit(STRANGER, "@bot https://example.com/some-page");
  await harness.settle();

  assert.deepEqual(harness.fetched, []);
  assert.doesNotMatch(userTurn(harness.contexts.at(-1)), /web page download/);
});

test("direct messages stay owner-only for page prefetch", async () => {
  const harness = createHarness();
  harness.emit(WEB_USER, "look at https://example.com/private", { dm: true });
  await harness.settle();
  assert.deepEqual(harness.fetched, []);

  harness.emit(OWNER, "look at https://example.com/private", { dm: true });
  await harness.settle();
  assert.deepEqual(harness.fetched, ["https://example.com/private"]);
});

test("says the page could not be opened when the extract fails", async () => {
  const harness = createHarness({ pageText: "ERROR: Tavily returned 502: bad gateway" });
  harness.emit(OWNER, "@bot https://example.com/broken");
  await harness.settle();

  const context = harness.contexts.at(-1);
  assert.match(userTurn(context), /not downloaded: Tavily returned 502: bad gateway/);
  assert.match(context[0].content, /say you could not open it/);
});

test("a disabled web prefetch gate downloads nothing", async () => {
  const harness = createHarness({ config: baseConfig({ webPrefetchEnabled: false }) });
  harness.emit(OWNER, "@bot https://example.com/some-page");
  await harness.settle();

  assert.deepEqual(harness.fetched, []);
  assert.doesNotMatch(userTurn(harness.contexts.at(-1)), /web page download/);
});
