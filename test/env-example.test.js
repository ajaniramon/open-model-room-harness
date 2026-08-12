import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "dotenv";

test("environment example has unique, opt-in relay and control settings", async () => {
  const source = await readFile(new URL("../.env.example", import.meta.url), "utf8");
  const keys = source
    .split(/\r?\n/)
    .map((line) => /^([A-Z][A-Z0-9_]*)=/.exec(line)?.[1])
    .filter(Boolean);
  const duplicates = [...new Set(keys.filter((key, index) => keys.indexOf(key) !== index))];
  assert.deepEqual(duplicates, []);

  const values = parse(source);
  assert.equal(values.CHAT_RELAY_ENABLED, "false");
  assert.equal(values.CHAT_RELAY_TTL_SECONDS, "86400");
  assert.equal(values.BEHAVIOR_MODE_ENABLED, "false");
  assert.equal(values.BEHAVIOR_MODE_DEFAULT, "manual");
  assert.equal(values.MCP_CONTROL_ENABLED, "false");
});
