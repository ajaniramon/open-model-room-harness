import assert from "node:assert/strict";
import test from "node:test";
import { Events } from "discord.js";
import { createDiscordBot } from "../src/discord-bot.js";

const BOT_ID = "111111111111111111";
const OWNER = { id: "222222222222222222", username: "owner_identity", bot: false };

function config() {
  return {
    ownerUserIds: new Set([OWNER.id]),
    ownerUsernames: new Set([OWNER.username]),
    blockedUsernames: new Set(),
    allowedChannelIds: new Set(),
    respondToBots: false,
    triggerMode: "mention",
    contextMessages: 10,
    contextTimestamps: false,
    timeZone: "UTC",
    chatProvider: "test",
    chatModel: "test-model",
    spontaneousEnabled: false,
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
  };
}

test("duplicate Discord delivery produces one model turn and one reply", async () => {
  const replies = [];
  let inferenceCalls = 0;
  let releaseInference;
  const inferenceStarted = new Promise((resolve) => {
    releaseInference = resolve;
  });

  const client = createDiscordBot({
    config: config(),
    nanoGpt: {
      complete: async () => {
        inferenceCalls += 1;
        // Keep the first delivery in flight while Discord redelivers the event.
        await inferenceStarted;
        return "Thanks G. Go backport those changes.";
      },
    },
    systemPrompt: "Integration-test system prompt.",
    logger: { info: () => undefined, error: () => undefined },
  });
  client.user = { id: BOT_ID, tag: "JJ#0001" };

  const message = {
    id: "traffic-log-message-2026-08-20-181233",
    content: "@JJ love your personality",
    channelId: "channel-a",
    guildId: "guild-a",
    author: OWNER,
    member: null,
    webhookId: null,
    createdTimestamp: Date.now(),
    attachments: new Map(),
    mentions: { has: (user) => user.id === BOT_ID },
    reference: null,
    channel: {
      type: 0,
      sendTyping: async () => undefined,
      messages: { fetch: async () => new Map() },
      send: async (payload) => {
        replies.push(payload.content);
        return { id: `sent-${replies.length}` };
      },
    },
    reply: async (payload) => {
      replies.push(payload.content);
      return { id: `reply-${replies.length}` };
    },
  };

  // Reproduce the traffic-log symptom: the same Discord event reaches the async
  // handler twice before the first model call has completed.
  client.emit(Events.MessageCreate, message);
  client.emit(Events.MessageCreate, message);
  await new Promise((resolve) => setImmediate(resolve));
  releaseInference();

  for (let tick = 0; tick < 20 && replies.length < 2; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  assert.equal(inferenceCalls, 1, "the duplicate event must not start another model turn");
  assert.deepEqual(replies, ["Thanks G. Go backport those changes."]);
});
