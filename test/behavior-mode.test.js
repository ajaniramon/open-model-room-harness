import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BehaviorModeController } from "../src/behavior-mode.js";

test("resolves disabled behavior modes as manual", () => {
  const controller = new BehaviorModeController({ settings: { enabled: false } });
  assert.deepEqual(controller.resolve({ guildId: "g", channelId: "c" }), {
    mode: "manual",
    scope: "global",
    guildId: null,
    channelId: null,
    source: "disabled",
    expiresAt: null,
    cooldownSeconds: 180,
    maxRepliesPerHour: 8,
  });
});

test("resolves channel overrides before guild and global modes", async () => {
  const controller = await new BehaviorModeController({
    settings: { enabled: true },
  }).load();
  await controller.setMode({ mode: "quiet" });
  await controller.setMode({ mode: "observe", guildId: "guild" });
  await controller.setMode({ mode: "auto", guildId: "guild", channelId: "channel" });

  assert.equal(controller.resolve({ guildId: "guild", channelId: "channel" }).mode, "auto");
  assert.equal(controller.resolve({ guildId: "guild", channelId: "other" }).mode, "observe");
  assert.equal(controller.resolve({ guildId: "other", channelId: "elsewhere" }).mode, "quiet");
});

test("expires scoped overrides and falls back to the next available scope", async () => {
  let now = Date.parse("2026-08-01T12:00:00.000Z");
  const controller = await new BehaviorModeController({
    settings: { enabled: true },
    now: () => now,
  }).load();
  await controller.setMode({ mode: "manual", guildId: "guild" });
  await controller.setMode({
    mode: "auto",
    guildId: "guild",
    channelId: "channel",
    durationMinutes: 10,
  });

  assert.equal(controller.resolve({ guildId: "guild", channelId: "channel" }).mode, "auto");
  now += 11 * 60_000;
  assert.equal(controller.resolve({ guildId: "guild", channelId: "channel" }).mode, "manual");
});

test("persists behavior mode state without hardcoded identities", async () => {
  const root = await mkdtemp(join(tmpdir(), "behavior-mode-"));
  const path = join(root, "state", "behavior-mode.json");
  try {
    const controller = await new BehaviorModeController({
      settings: { enabled: true },
      statePath: path,
      now: () => Date.parse("2026-08-01T12:00:00.000Z"),
    }).load();
    await controller.setMode({
      mode: "auto",
      channelId: "123",
      cooldownSeconds: 30,
      maxRepliesPerHour: 2,
    });

    const raw = await readFile(path, "utf8");
    assert.doesNotMatch(raw, /JJ|Gremy/i);
    const reloaded = await new BehaviorModeController({
      settings: { enabled: true },
      statePath: path,
    }).load();
    assert.deepEqual(reloaded.resolve({ channelId: "123" }), {
      mode: "auto",
      scope: "channel",
      guildId: null,
      channelId: "123",
      source: "channel",
      expiresAt: null,
      cooldownSeconds: 30,
      maxRepliesPerHour: 2,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("maps behavior modes to reply, capture, and auto decisions", async () => {
  const controller = await new BehaviorModeController({
    settings: { enabled: true },
  }).load();

  await controller.setMode({ mode: "manual" });
  assert.equal(controller.allowsNonOwnerReply(), true);
  assert.equal(controller.allowsSpontaneousReply(), false);
  assert.equal(controller.allowsMemoryCapture(), false);

  await controller.setMode({ mode: "observe" });
  assert.equal(controller.allowsNonOwnerReply(), false);
  assert.equal(controller.allowsSpontaneousReply(), false);
  assert.equal(controller.allowsMemoryCapture(), true);

  await controller.setMode({ mode: "auto" });
  assert.equal(controller.allowsNonOwnerReply(), true);
  assert.equal(controller.allowsSpontaneousReply(), true);
  assert.equal(controller.allowsMemoryCapture(), false);

  await controller.setMode({ mode: "quiet" });
  assert.equal(controller.allowsNonOwnerReply(), false);
  assert.equal(controller.allowsSpontaneousReply(), false);
  assert.equal(controller.allowsMemoryCapture("unused", "always"), false);
});

test("enforces auto cooldown and hourly reply limits per scope", async () => {
  let now = 1_000;
  const controller = await new BehaviorModeController({
    settings: { enabled: true },
    now: () => now,
  }).load();
  await controller.setMode({
    mode: "auto",
    channelId: "channel",
    cooldownSeconds: 10,
    maxRepliesPerHour: 2,
  });

  assert.deepEqual(controller.canRecordAutoResponse({ channelId: "channel" }), { allowed: true });
  now += 1_000;
  assert.deepEqual(controller.canRecordAutoResponse({ channelId: "channel" }), {
    allowed: false,
    reason: "auto_cooldown",
  });
  now += 10_000;
  assert.deepEqual(controller.canRecordAutoResponse({ channelId: "channel" }), { allowed: true });
  now += 10_000;
  assert.deepEqual(controller.canRecordAutoResponse({ channelId: "channel" }), {
    allowed: false,
    reason: "auto_hourly_limit",
  });
  now += 60 * 60_000;
  assert.deepEqual(controller.canRecordAutoResponse({ channelId: "channel" }), { allowed: true });
});

test("applies inherited auto limits to the resolved behavior scope", async () => {
  let now = 1_000;
  const controller = await new BehaviorModeController({
    settings: { enabled: true },
    now: () => now,
  }).load();
  await controller.setMode({
    mode: "auto",
    guildId: "guild",
    cooldownSeconds: 0,
    maxRepliesPerHour: 1,
  });

  assert.deepEqual(
    controller.canRecordAutoResponse({ guildId: "guild", channelId: "one" }),
    { allowed: true },
  );
  now += 1;
  assert.deepEqual(
    controller.canRecordAutoResponse({ guildId: "guild", channelId: "two" }),
    { allowed: false, reason: "auto_hourly_limit" },
  );
});

test("reloads behavior mode state written by another process", async () => {
  const root = await mkdtemp(join(tmpdir(), "behavior-mode-watch-"));
  const path = join(root, "state", "behavior-mode.json");
  try {
    const controller = await new BehaviorModeController({
      settings: { enabled: true },
      statePath: path,
    }).load();
    await controller.startWatching();
    assert.equal(controller.resolve().mode, "manual");

    await writeFile(
      path,
      JSON.stringify({
        entries: [
          {
            type: "global",
            guildId: null,
            channelId: null,
            mode: "quiet",
            expiresAt: null,
            cooldownSeconds: 180,
            maxRepliesPerHour: 8,
            updatedAt: new Date().toISOString(),
          },
        ],
      }),
      "utf8",
    );
    await new Promise((resolve) => setTimeout(resolve, 150));

    assert.equal(controller.resolve().mode, "quiet");
    await controller.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
