import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  activeCircuitForItem,
  backoffMinutesForAttempt,
  createWakeCircuitState,
  normalizeBackoffSchedule,
} from "../backoff.js";

const root = fileURLToPath(new URL("..", import.meta.url));

async function read(relativePath) {
  return readFile(join(root, relativePath), "utf8");
}

test("manifest references files that exist", async () => {
  const manifest = JSON.parse(await read("manifest.json"));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.background.service_worker, "background.js");

  const referencedFiles = [
    manifest.background.service_worker,
    manifest.action.default_popup,
    manifest.options_ui.page,
    ...manifest.content_scripts.flatMap((entry) => entry.js),
  ];

  await Promise.all(referencedFiles.map((path) => read(path)));
});

test("extension scripts pass Node syntax checks", () => {
  for (const script of ["backoff.js", "background.js", "content.js", "options.js", "popup.js"]) {
    execFileSync(process.execPath, ["--check", join(root, script)], { stdio: "pipe" });
  }
});

test("backoff schedule is normalized and capped", () => {
  assert.deepEqual(normalizeBackoffSchedule("5, 2, 30, nope, 2000"), [5, 5, 30, 1440]);
  assert.deepEqual(normalizeBackoffSchedule(""), [5, 15, 30, 60]);
  assert.equal(backoffMinutesForAttempt([5, 15, 30, 60], 1), 5);
  assert.equal(backoffMinutesForAttempt([5, 15, 30, 60], 3), 30);
  assert.equal(backoffMinutesForAttempt([5, 15, 30, 60], 99), 60);
});

test("circuit advances only while the same oldest item remains", () => {
  const first = createWakeCircuitState({ itemId: "relay-1", now: 1_000, schedule: [5, 15, 30] });
  assert.deepEqual(first, {
    itemId: "relay-1",
    attempts: 1,
    lastWakeAt: 1_000,
    backoffUntil: 301_000,
  });

  const second = createWakeCircuitState({ previous: first, itemId: "relay-1", now: 400_000, schedule: [5, 15, 30] });
  assert.equal(second.attempts, 2);
  assert.equal(second.backoffUntil, 1_300_000);
  assert.equal(activeCircuitForItem(second, "relay-2"), null);

  const replacement = createWakeCircuitState({ previous: second, itemId: "relay-2", now: 500_000, schedule: [5, 15, 30] });
  assert.equal(replacement.attempts, 1);
  assert.equal(createWakeCircuitState({ previous: replacement, itemId: "", now: 600_000, schedule: [5] }), null);
});

test("prototype contains no companion or Discord scope names", async () => {
  const source = await Promise.all([
    read("background.js"),
    read("content.js"),
    read("options.js"),
    read("popup.js"),
    read("manifest.json"),
  ]);
  const combined = source.join("\n").toLowerCase();
  for (const forbidden of ["gremy", "haven", "thirdeye", "guildid", "channelid"]) {
    assert.equal(combined.includes(forbidden), false, `found hardcoded name: ${forbidden}`);
  }
});

test("remote harness access is optional", async () => {
  const manifest = JSON.parse(await read("manifest.json"));
  assert.deepEqual(manifest.optional_host_permissions, ["https://*/*"]);
  assert.equal(manifest.host_permissions.includes("<all_urls>"), false);
});
