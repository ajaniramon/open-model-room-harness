import assert from "node:assert/strict";
import test from "node:test";
import { OwnerHeartbeat } from "../src/owner-heartbeat.js";

function fixture(overrides = {}) {
  let queued = null;
  let scheduled = null;
  const owner = {
    id: "123456789012345678",
    username: "owner",
    globalName: "Owner",
    bot: false,
    createDM: async () => ({
      id: "dm-channel",
      messages: {
        fetch: async () => new Map([
          ["one", {
            createdTimestamp: 1_000,
            content: "Earlier DM",
            attachments: new Map(),
            author: owner,
          }],
        ]),
      },
    }),
  };
  const chatRelay = {
    enabled: true,
    hasActiveKind: () => false,
    enqueue: (item) => {
      queued = item;
      return "relay-heartbeat";
    },
  };
  const client = {
    user: { id: "bot", username: "assistant", globalName: "Assistant" },
    users: { fetch: async () => owner },
    isReady: () => true,
  };
  const config = {
    enabled: true,
    ownerUserId: owner.id,
    minMinutes: 60,
    maxMinutes: 180,
    recentInteractionMinutes: 30,
    contextMessages: 8,
  };
  const heartbeat = new OwnerHeartbeat({
    config,
    client,
    chatRelay,
    canRun: () => true,
    now: () => 10 * 60_000,
    random: () => 0.5,
    setTimer: (callback, delay) => {
      scheduled = { callback, delay, unref() {} };
      return scheduled;
    },
    clearTimer: () => {},
    logger: { info() {}, error() {} },
    ...overrides,
  });
  return { heartbeat, chatRelay, owner, getQueued: () => queued, getScheduled: () => scheduled };
}

test("queues an owner-DM decision opportunity without sending a message", async () => {
  const { heartbeat, getQueued } = fixture();
  const result = await heartbeat.evaluate();
  assert.deepEqual(result, { outcome: "queued", relayId: "relay-heartbeat" });
  const queued = getQueued();
  assert.equal(queued.kind, "owner-heartbeat");
  assert.equal(queued.spontaneous, true);
  assert.equal(queued.directResponse, false);
  assert.equal(queued.message.channelId, "dm-channel");
  assert.match(queued.message.content, /Contact the owner only if/);
  assert.match(queued.context[0].content, /only an opportunity to decide/);
  assert.match(queued.context[1].content, /Earlier DM/);
});

test("suppresses owner heartbeat opportunities after recent owner activity", async () => {
  let now = 1_000;
  const { heartbeat, owner, getQueued } = fixture({ now: () => now });
  assert.equal(heartbeat.recordOwnerInteraction(owner), true);
  now += 10 * 60_000;
  assert.deepEqual(await heartbeat.evaluate(), { outcome: "recent_interaction" });
  assert.equal(getQueued(), null);
});

test("does not queue a second owner heartbeat while one is active", async () => {
  const { heartbeat, chatRelay, getQueued } = fixture();
  chatRelay.hasActiveKind = (kind) => kind === "owner-heartbeat";
  assert.deepEqual(await heartbeat.evaluate(), { outcome: "already_pending" });
  assert.equal(getQueued(), null);
});

test("schedules randomized heartbeat spacing inside configured bounds", () => {
  const { heartbeat, getScheduled } = fixture();
  assert.equal(heartbeat.start(), true);
  assert.equal(getScheduled().delay, 120 * 60_000);
  assert.equal(heartbeat.status().running, true);
  heartbeat.stop();
  assert.equal(heartbeat.status().running, false);
});
