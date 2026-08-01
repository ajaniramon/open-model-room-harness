import assert from "node:assert/strict";
import test from "node:test";
import { Events } from "discord.js";
import { createDiscordBot } from "../src/discord-bot.js";

const OWNER = { id: "222222222222222222", username: "owner_identity", bot: false };
const STRANGER = { id: "999999999999999999", username: "stranger", bot: false };

function baseConfig() {
  return {
    ownerUserIds: new Set([OWNER.id]),
    ownerUsernames: new Set([OWNER.username]),
    runtimeControlAllowUsernameFallback: true,
    blockedUsernames: new Set(),
    allowedChannelIds: new Set(),
    respondToBots: false,
    triggerMode: "mention",
    contextMessages: 5,
    contextTimestamps: false,
    timeZone: "UTC",
    nanoGptModel: "test-model",
    visionModel: "test-vision",
    spontaneousEnabled: true,
    spontaneousMinChars: 12,
    // Fire on the first eligible message so the test does not depend on the gate's
    // random window.
    spontaneousMinMessages: 2,
    spontaneousMaxMessages: 2,
    spontaneousCooldownMs: 0,
    spontaneousMaxPerHour: 20,
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
  };
}

function createHarness({ maintenanceEnabled = false, complete } = {}) {
  const sent = [];
  const state = { inferences: 0 };
  const runtimeControl = {
    maintenanceEnabled,
    applyPresence: async () => undefined,
    execute: async (command) => {
      if (command.action === "maintenance_on") runtimeControl.maintenanceEnabled = true;
      if (command.action === "maintenance_off") runtimeControl.maintenanceEnabled = false;
      return { response: `[${command.action}]` };
    },
  };
  const nanoGpt = {
    complete: async (...args) => {
      state.inferences += 1;
      return complete ? await complete(...args) : "model answer";
    },
  };
  const client = createDiscordBot({
    config: baseConfig(),
    nanoGpt,
    runtimeControl,
    systemPrompt: "system",
    logger: { info: () => undefined, error: () => undefined },
  });
  client.user = { id: "111111111111111111", tag: "JJ#0001" };

  let counter = 0;
  const emit = (author, channelId, content) => {
    counter += 1;
    const index = counter;
    client.emit(Events.MessageCreate, {
      id: `m${index}`,
      content,
      channelId,
      guildId: "GUILD",
      author,
      member: null,
      webhookId: null,
      createdTimestamp: Date.now(),
      attachments: new Map(),
      mentions: { has: () => content.includes("@JJ") },
      reference: null,
      channel: {
        type: 0,
        sendTyping: async () => undefined,
        messages: { fetch: async () => new Map() },
        send: async (payload) => {
          sent.push({ channelId, text: payload.content ?? "[attachment]" });
          return { id: `s${index}` };
        },
      },
      reply: async (payload) => {
        sent.push({ channelId, text: payload.content ?? "[attachment]" });
        return { id: `r${index}` };
      },
    });
  };
  const settle = async (ticks = 6) => {
    for (let index = 0; index < ticks; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  return { client, runtimeControl, sent, state, emit, settle };
}

test("maintenance discards a stranger's mention before inference", async () => {
  const harness = createHarness({ maintenanceEnabled: true });
  harness.emit(STRANGER, "channel-b", "@JJ are you awake?");
  await harness.settle();
  assert.equal(harness.state.inferences, 0);
  assert.deepEqual(harness.sent, []);
});

test("maintenance keeps normal owner replies", async () => {
  const harness = createHarness({ maintenanceEnabled: true });
  harness.emit(OWNER, "channel-b", "@JJ status of the incident?");
  await harness.settle();
  assert.equal(harness.state.inferences, 1);
  assert.deepEqual(harness.sent, [{ channelId: "channel-b", text: "model answer" }]);
});

test("maintenance suppresses spontaneous participation in every channel", async () => {
  const harness = createHarness({ maintenanceEnabled: true });
  for (const text of ["first long owner message", "second long owner message", "third long owner message"]) {
    harness.emit(OWNER, "channel-b", text);
    await harness.settle(2);
  }
  await harness.settle();
  assert.equal(harness.state.inferences, 0);
  assert.deepEqual(harness.sent, []);

  // The gate must not have advanced while silenced, so waking JJ does not
  // immediately release a queued spontaneous message.
  harness.runtimeControl.maintenanceEnabled = false;
  harness.emit(OWNER, "channel-b", "fourth long owner message");
  await harness.settle();
  assert.equal(harness.state.inferences, 0);
});

test("enabling maintenance from another channel drops queued and in-flight turns", async () => {
  let releaseInference;
  const harness = createHarness({
    complete: async () => {
      await new Promise((resolve) => {
        releaseInference = resolve;
      });
      return "slow answer";
    },
  });

  harness.emit(STRANGER, "channel-b", "@JJ first question");
  harness.emit(STRANGER, "channel-b", "@JJ queued question");
  await harness.settle(2);
  assert.equal(harness.state.inferences, 1, "only the first turn should have started");

  harness.emit(OWNER, "channel-a", "@JJ maintenance on");
  await harness.settle(2);
  assert.equal(harness.runtimeControl.maintenanceEnabled, true);

  releaseInference();
  await harness.settle();

  assert.equal(harness.state.inferences, 1, "the queued turn must never reach the model");
  assert.deepEqual(
    harness.sent,
    [{ channelId: "channel-a", text: "[maintenance_on]" }],
    "only the control acknowledgement should be posted",
  );
});

test("disabling maintenance restores normal replies", async () => {
  const harness = createHarness({ maintenanceEnabled: true });
  harness.emit(OWNER, "channel-a", "@JJ wake up");
  await harness.settle();
  assert.equal(harness.runtimeControl.maintenanceEnabled, false);

  harness.emit(STRANGER, "channel-b", "@JJ hello again");
  await harness.settle();
  assert.equal(harness.state.inferences, 1);
  assert.deepEqual(harness.sent.at(-1), { channelId: "channel-b", text: "model answer" });
});
