import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  allowsMemoryCapture,
  allowsReplyDuringQuietModes,
  isRuntimeControlAuthorized,
  parseRuntimeControlCommand,
  RuntimeControl,
} from "../src/runtime-control.js";

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
  const path = join(root, "state", "runtime-control.json");
  try {
    const control = await new RuntimeControl({ statePath: path, now: () => Date.now() }).load();
    await control.execute({ action: "observation_on" }, { userId: "123" });
    assert.equal(control.observationEnabled, true);

    await control.execute({ action: "maintenance_on" }, { userId: "123" });
    assert.equal(control.observationEnabled, false, "maintenance must win over observation");
    assert.equal(control.maintenanceEnabled, true);

    await control.execute({ action: "observation_on" }, { userId: "123" });
    assert.equal(control.maintenanceEnabled, false);

    const reloaded = await new RuntimeControl({ statePath: path }).load();
    assert.equal(reloaded.observationEnabled, true);
    const status = await reloaded.execute({ action: "status" }, {});
    assert.match(status.response, /State: observation/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("persists maintenance state and audits controls without model inference", async () => {
  const root = await mkdtemp(join(tmpdir(), "runtime-control-"));
  const path = join(root, "state", "runtime-control.json");
  const events = [];
  try {
    const control = await new RuntimeControl({
      statePath: path,
      auditLogger: { log: async (event) => events.push(event), close: async () => undefined },
      restartEnabled: true,
      now: () => Date.parse("2026-08-01T12:00:00.000Z"),
      startedAt: Date.parse("2026-08-01T10:30:00.000Z"),
    }).load();
    const enabled = await control.execute({ action: "maintenance_on" }, { userId: "123", model: "test-model" });
    assert.match(enabled.response, /owner-only/);
    assert.equal(control.maintenanceEnabled, true);
    assert.equal(JSON.parse(await readFile(path, "utf8")).maintenanceEnabled, true);

    const status = await control.execute({ action: "status" }, { userId: "123", model: "test-model" });
    assert.match(status.response, /State: maintenance/);
    assert.match(status.response, /Uptime: 1h 30m/);

    await control.execute({ action: "maintenance_off" }, { userId: "123" });
    assert.equal((await new RuntimeControl({ statePath: path }).load()).maintenanceEnabled, false);
    assert.equal(events.some((event) => event.type === "runtime_maintenance_changed"), true);
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
