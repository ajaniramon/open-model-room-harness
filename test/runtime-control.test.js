import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { allowsMessageDuringMaintenance, isRuntimeControlAuthorized, parseRuntimeControlCommand, RuntimeControl } from "../src/runtime-control.js";

test("parses only exact runtime control commands", () => {
  assert.deepEqual(parseRuntimeControlCommand("@JJ maintenance on"), { action: "maintenance_on" });
  assert.deepEqual(parseRuntimeControlCommand("<@123456789012345678> wake up"), { action: "maintenance_off" });
  assert.deepEqual(parseRuntimeControlCommand("JJ restart runtime"), { action: "restart" });
  assert.deepEqual(parseRuntimeControlCommand("@JJ status"), { action: "status" });
  assert.equal(parseRuntimeControlCommand("@JJ should we restart runtime later?"), null);
});

test("requires a numeric owner ID for restart while allowing configured fallback elsewhere", () => {
  const config = { ownerUserIds: new Set(["123"]), ownerUsernames: new Set(["owner"]), runtimeControlAllowUsernameFallback: true };
  assert.equal(isRuntimeControlAuthorized({ id: "123", username: "renamed" }, config, "restart"), true);
  assert.equal(isRuntimeControlAuthorized({ id: "999", username: "OWNER" }, config, "restart"), false);
  assert.equal(isRuntimeControlAuthorized({ id: "999", username: "OWNER" }, config, "maintenance_on"), true);
});

test("maintenance suppresses every message except an authorized control", () => {
  const control = { maintenanceEnabled: true };
  assert.equal(allowsMessageDuringMaintenance(control, null, false), false);
  assert.equal(allowsMessageDuringMaintenance(control, { action: "wake" }, false), false);
  assert.equal(allowsMessageDuringMaintenance(control, { action: "maintenance_off" }, true), true);
  assert.equal(allowsMessageDuringMaintenance({ maintenanceEnabled: false }, null, false), true);
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
    assert.match((await control.execute({ action: "maintenance_on" }, { userId: "123" })).response, /paused/);
    assert.equal(JSON.parse(await readFile(path, "utf8")).maintenanceEnabled, true);
    assert.match((await control.execute({ action: "status" }, { model: "test-model" })).response, /1h 30m/);
    await control.execute({ action: "maintenance_off" });
    assert.equal((await new RuntimeControl({ statePath: path }).load()).maintenanceEnabled, false);
    assert.equal(events.some((event) => event.type === "runtime_maintenance_changed"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("gates supervised restarts in configuration", async () => {
  const auditLogger = { log: async () => undefined, close: async () => undefined };
  assert.match((await new RuntimeControl({ statePath: "unused", auditLogger }).execute({ action: "restart" })).response, /disabled/);
  assert.equal((await new RuntimeControl({ statePath: "unused", auditLogger, restartEnabled: true }).execute({ action: "restart" })).restart, true);
});
