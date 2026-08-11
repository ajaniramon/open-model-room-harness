import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

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
  for (const script of ["background.js", "content.js", "options.js", "popup.js"]) {
    execFileSync(process.execPath, ["--check", join(root, script)], { stdio: "pipe" });
  }
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
  assert.deepEqual(manifest.optional_host_permissions, ["http://*/*", "https://*/*"]);
  assert.equal(manifest.host_permissions.includes("<all_urls>"), false);
});
