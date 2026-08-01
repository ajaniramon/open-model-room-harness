import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ParticipationController,
  normalizeParticipationPolicy,
  parseParticipationCommand,
} from "../src/participation-policy.js";

async function fixture(policy = {}, now = () => 0) {
  const root = await mkdtemp(join(tmpdir(), "jj-participation-"));
  const configPath = join(root, "config.json");
  const statePath = join(root, "state.json");
  await writeFile(configPath, "{}\n", "utf8");
  const records = [];
  const controller = await new ParticipationController({
    policy: normalizeParticipationPolicy(policy),
    configPath,
    statePath,
    auditLogger: { log: async (record) => records.push(record) },
    now,
  }).load();
  return {
    controller,
    configPath,
    statePath,
    records,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

function request(overrides = {}) {
  return {
    guildId: "guild",
    channelId: "channel",
    userId: "user",
    username: "person",
    explicitMention: true,
    kind: "direct",
    ...overrides,
  };
}

test("parses exact owner participation commands without model inference", () => {
  assert.deepEqual(parseParticipationCommand("<@123456789012345> limits show"), { action: "show" });
  assert.deepEqual(parseParticipationCommand("<@123456789012345> limits set conversation.turns 4"), {
    action: "set",
    path: "conversation.turns",
    value: "4",
  });
  assert.deepEqual(
    parseParticipationCommand("<@123456789012345> limits unban <@987654321098765>"),
    { action: "unban", userId: "987654321098765" },
  );
  assert.equal(parseParticipationCommand("please explain the limits"), null);
});

test("enforces one global guild budget across channels while exempting the owner", async () => {
  const fx = await fixture({
    budget: { maxResponses: 2, windowMinutes: 10 },
    cooldown: { baseSeconds: 0, maxSeconds: 0 },
  });
  try {
    const first = await fx.controller.reserve(request({ userId: "one", channelId: "a" }));
    await fx.controller.commit(first.reservationId);
    const second = await fx.controller.reserve(request({ userId: "two", channelId: "b" }));
    await fx.controller.commit(second.reservationId);
    assert.equal((await fx.controller.reserve(request({ userId: "three", channelId: "c" }))).reason, "global_budget");
    assert.equal((await fx.controller.reserve(request({ userId: "owner", isOwner: true }))).allowed, true);
  } finally {
    await fx.cleanup();
  }
});

test("cancelled reservations return their global budget slot", async () => {
  const fx = await fixture({ budget: { maxResponses: 1, windowMinutes: 10 } });
  try {
    const first = await fx.controller.reserve(request());
    assert.equal((await fx.controller.reserve(request({ userId: "other" }))).reason, "global_budget");
    fx.controller.cancel(first.reservationId);
    assert.equal((await fx.controller.reserve(request({ userId: "other" }))).allowed, true);
  } finally {
    await fx.cleanup();
  }
});

test("opens a bounded same-user conversation and then requires a fresh mention", async () => {
  let now = 1_000;
  const fx = await fixture({
    conversation: { turns: 3, idleMinutes: 10 },
    cooldown: { baseSeconds: 0, maxSeconds: 0 },
  }, () => now);
  const session = { guildId: "guild", channelId: "channel", userId: "user" };
  try {
    const opening = await fx.controller.reserve(request());
    await fx.controller.commit(opening.reservationId);
    assert.equal(fx.controller.hasActiveConversation(session), true);

    for (let index = 0; index < 2; index += 1) {
      now += 1;
      const followup = await fx.controller.reserve(request({ explicitMention: false, continuation: true }));
      await fx.controller.commit(followup.reservationId);
    }
    assert.equal(fx.controller.hasActiveConversation(session), false);
  } finally {
    await fx.cleanup();
  }
});

test("progressive cooldown rejects rapid triggers and decays after quiet time", async () => {
  let now = 0;
  const fx = await fixture({
    cooldown: { baseSeconds: 3, multiplier: 2, maxSeconds: 60, decaySeconds: 120, resetMinutes: 10 },
  }, () => now);
  try {
    const first = await fx.controller.reserve(request());
    await fx.controller.commit(first.reservationId);
    assert.equal((await fx.controller.reserve(request())).reason, "user_cooldown");
    now = 3_001;
    const second = await fx.controller.reserve(request());
    await fx.controller.commit(second.reservationId);
    now += 3_001;
    const denied = await fx.controller.reserve(request());
    assert.equal(denied.reason, "user_cooldown");
    assert.ok(denied.retryAt > now);
  } finally {
    await fx.cleanup();
  }
});

test("autobans only after repeated explicit cooldown abuse and unlocks automatically", async () => {
  let now = 10_000;
  const fx = await fixture({
    budget: { maxResponses: 50, windowMinutes: 10 },
    cooldown: { baseSeconds: 60, maxSeconds: 60 },
    autoban: {
      enabled: true,
      triggers: 3,
      windowSeconds: 20,
      cooldownRejections: 2,
      durationMinutes: 1,
      repeatDurationMinutes: 2,
      maxDurationMinutes: 10,
    },
  }, () => now);
  try {
    const first = await fx.controller.reserve(request());
    await fx.controller.commit(first.reservationId);
    assert.equal((await fx.controller.reserve(request())).reason, "user_cooldown");
    assert.equal((await fx.controller.reserve(request())).reason, "spam_autoban");
    assert.equal((await fx.controller.reserve(request())).reason, "temporary_ban");
    assert.equal(fx.records.some((record) => record.type === "participation_autoban"), true);

    now += 60_001;
    assert.equal((await fx.controller.reserve(request())).allowed, true);
    const persisted = JSON.parse(await readFile(fx.statePath, "utf8"));
    assert.equal(persisted.bans.length, 0);
  } finally {
    await fx.cleanup();
  }
});

test("hot owner updates are validated, persisted to config.json, and immediately active", async () => {
  const fx = await fixture();
  try {
    const response = await fx.controller.executeAdminCommand(
      { action: "set", path: "budget.maxResponses", value: "7" },
      { guildId: "guild" },
    );
    assert.match(response, /budget\.maxResponses/);
    assert.equal(fx.controller.policy.budget.maxResponses, 7);
    assert.equal(JSON.parse(await readFile(fx.configPath, "utf8")).participation.budget.maxResponses, 7);
    await assert.rejects(
      fx.controller.executeAdminCommand(
        { action: "set", path: "budget.maxResponses", value: "unlimited" },
        { guildId: "guild" },
      ),
      /integer/,
    );
  } finally {
    await fx.cleanup();
  }
});
