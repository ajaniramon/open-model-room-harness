import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BehaviorModeController } from "../src/behavior-mode.js";
import {
  allowsMemoryCapture,
  allowsReplyDuringQuietModes,
  isRuntimeControlAuthorized,
  parseRuntimeControlCommand,
  RuntimeControl,
} from "../src/runtime-control.js";

async function unifiedControl(root, options = {}) {
  const behaviorPath = join(root, "state", "behavior-mode.json");
  const behaviorModeController = await new BehaviorModeController({
    settings: { enabled: true, defaultMode: options.defaultMode || "manual" },
    statePath: behaviorPath,
    auditLogger: options.auditLogger,
    now: options.now,
  }).load();
  const runtimeControl = await new RuntimeControl({
    statePath: join(root, "state", "runtime-control.json"),
    behaviorModeController,
    ...options,
  }).load();
  return { behaviorPath, behaviorModeController, runtimeControl };
}

test("parses only exact runtime control commands", () => {
  assert.deepEqual(parseRuntimeControlCommand("@bot maintenance on"), { action: "maintenance_on" });
  assert.deepEqual(parseRuntimeControlCommand("<@123456789012345678> wake up"), { action: "maintenance_off" });
  assert.deepEqual(parseRuntimeControlCommand("restart runtime"), { action: "restart" });
  assert.deepEqual(parseRuntimeControlCommand("@bot status"), { action: "status" });
  assert.deepEqual(parseRuntimeControlCommand("@bot activa el modo mantenimiento"), { action: "maintenance_on" });
  assert.deepEqual(parseRuntimeControlCommand("@bot stealth mode on"), { action: "observation_on" });
  assert.deepEqual(parseRuntimeControlCommand("@bot observation off"), { action: "observation_off" });
  assert.equal(parseRuntimeControlCommand("@bot should we restart runtime later?"), null);
  assert.equal(parseRuntimeControlCommand("@bot tell me about maintenance mode"), null);
});

test("requires a numeric owner ID for restart while allowing configured fallback elsewhere", () => {
  const config = {
    ownerUserIds: new Set(["123"]),
    ownerUsernames: new Set(["owner"]),
    runtimeControlAllowUsernameFallback: true,
  };
  assert.equal(isRuntimeControlAuthorized({ id: "123", username: "renamed" }, config, "restart"), true);
  assert.equal(isRuntimeControlAuthorized({ id: "999", username: "OWNER" }, config, "restart"), false);
  assert.equal(isRuntimeControlAuthorized({ id: "999", username: "OWNER" }, config, "maintenance_on"), true);
  config.runtimeControlAllowUsernameFallback = false;
  assert.equal(isRuntimeControlAuthorized({ id: "999", username: "owner" }, config, "status"), false);
});

test("maintenance suppresses every non-owner message before inference", () => {
  const control = { maintenanceEnabled: true };
  assert.equal(allowsReplyDuringQuietModes(control, false), false);
  assert.equal(allowsReplyDuringQuietModes(control, true), true);
  assert.equal(allowsReplyDuringQuietModes({ maintenanceEnabled: false }, false), true);
});

test("maintenance suppresses spontaneous participation even for the owner", () => {
  const control = { maintenanceEnabled: true };
  assert.equal(allowsReplyDuringQuietModes(control, true, { spontaneous: true }), false);
  assert.equal(allowsReplyDuringQuietModes(control, false, { spontaneous: true }), false);
  assert.equal(
    allowsReplyDuringQuietModes({ maintenanceEnabled: false }, false, { spontaneous: true }),
    true,
  );
});

test("observation mode silences everyone but the owner while keeping capture alive", () => {
  const control = { maintenanceEnabled: false, observationEnabled: true };
  assert.equal(allowsReplyDuringQuietModes(control, false), false);
  assert.equal(allowsReplyDuringQuietModes(control, true), true);
  assert.equal(allowsReplyDuringQuietModes(control, true, { spontaneous: true }), false);
  assert.equal(allowsMemoryCapture(control), true);
});

test("maintenance freezes capture and the two quiet modes are mutually exclusive", async () => {
  assert.equal(allowsMemoryCapture({ maintenanceEnabled: true, observationEnabled: true }), false);
  assert.equal(allowsMemoryCapture({ maintenanceEnabled: false, observationEnabled: false }), false);
  assert.equal(
    allowsMemoryCapture({ maintenanceEnabled: false, observationEnabled: false }, "always"),
    true,
  );

  const root = await mkdtemp(join(tmpdir(), "runtime-observation-"));
  try {
    const { behaviorPath, runtimeControl: control } = await unifiedControl(root, {
      now: () => Date.now(),
    });
    await control.execute({ action: "observation_on" }, { userId: "123" });
    assert.equal(control.observationEnabled, true);

    await control.execute({ action: "maintenance_on" }, { userId: "123" });
    assert.equal(control.observationEnabled, false, "maintenance must win over observation");
    assert.equal(control.maintenanceEnabled, true);

    await control.execute({ action: "observation_on" }, { userId: "123" });
    assert.equal(control.maintenanceEnabled, false);

    const reloadedBehavior = await new BehaviorModeController({
      settings: { enabled: true },
      statePath: behaviorPath,
    }).load();
    const reloaded = await new RuntimeControl({
      statePath: join(root, "state", "runtime-control.json"),
      behaviorModeController: reloadedBehavior,
    }).load();
    assert.equal(reloaded.observationEnabled, true);
    const status = await reloaded.execute({ action: "status" }, {});
    assert.match(status.response, /State: observe/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("persists maintenance state and audits controls without model inference", async () => {
  const root = await mkdtemp(join(tmpdir(), "runtime-control-"));
  const events = [];
  const auditLogger = { log: async (event) => events.push(event), close: async () => undefined };
  try {
    const { behaviorPath, runtimeControl: control } = await unifiedControl(root, {
      auditLogger,
      restartEnabled: true,
      now: () => Date.parse("2026-08-01T12:00:00.000Z"),
      startedAt: Date.parse("2026-08-01T10:30:00.000Z"),
    });
    const enabled = await control.execute({ action: "maintenance_on" }, { userId: "123", model: "test-model" });
    assert.match(enabled.response, /owner-only/);
    assert.equal(control.maintenanceEnabled, true);
    assert.equal(JSON.parse(await readFile(behaviorPath, "utf8")).entries[0].mode, "maintenance");

    const status = await control.execute({ action: "status" }, { userId: "123", model: "test-model" });
    assert.match(status.response, /State: maintenance/);
    assert.match(status.response, /Uptime: 1h 30m/);

    await control.execute({ action: "maintenance_off" }, { userId: "123" });
    const reloadedBehavior = await new BehaviorModeController({
      settings: { enabled: true },
      statePath: behaviorPath,
    }).load();
    assert.equal(reloadedBehavior.resolve().mode, "manual");
    assert.equal(events.some((event) => event.type === "runtime_maintenance_changed"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("migrates legacy runtime state once and then keeps unified state authoritative", async () => {
  const root = await mkdtemp(join(tmpdir(), "runtime-migration-"));
  const legacyPath = join(root, "state", "runtime-control.json");
  try {
    await mkdir(join(root, "state"), { recursive: true });
    await writeFile(
      legacyPath,
      JSON.stringify({ maintenanceEnabled: false, observationEnabled: true }),
      { encoding: "utf8", flag: "wx" },
    );
    const first = await unifiedControl(root);
    assert.equal(first.runtimeControl.mode, "observe");
    assert.equal(JSON.parse(await readFile(first.behaviorPath, "utf8")).entries[0].mode, "observe");

    await writeFile(
      legacyPath,
      JSON.stringify({ maintenanceEnabled: true, observationEnabled: false }),
      "utf8",
    );
    const secondBehavior = await new BehaviorModeController({
      settings: { enabled: true },
      statePath: first.behaviorPath,
    }).load();
    const second = await new RuntimeControl({
      statePath: legacyPath,
      behaviorModeController: secondBehavior,
    }).load();
    assert.equal(second.mode, "observe");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("gates supervised restarts in configuration", async () => {
  const auditLogger = { log: async () => undefined, close: async () => undefined };
  const disabled = new RuntimeControl({ statePath: "unused", auditLogger, restartEnabled: false });
  assert.match((await disabled.execute({ action: "restart" })).response, /disabled/);
  const enabled = new RuntimeControl({ statePath: "unused", auditLogger, restartEnabled: true });
  assert.equal((await enabled.execute({ action: "restart" })).restart, true);
});
