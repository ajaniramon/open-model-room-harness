import assert from "node:assert/strict";
import test from "node:test";
import { setting, valueAt } from "../src/config-source.js";

test("config.json values take precedence and environment variables remain a fallback", () => {
  const source = { model: { name: "json-model" } };
  const environment = { NANOGPT_MODEL: "env-model", JJ_CONTEXT_MESSAGES: "42" };

  assert.equal(valueAt(source, "model.name"), "json-model");
  assert.equal(setting(source, "model.name", "NANOGPT_MODEL", "default", environment), "json-model");
  assert.equal(
    setting(source, "discord.contextMessages", "JJ_CONTEXT_MESSAGES", 24, environment),
    "42",
  );
  assert.equal(setting(source, "missing.value", "MISSING", "default", environment), "default");
});

test("empty arrays and null are explicit JSON values rather than environment fallbacks", () => {
  const source = { permissions: { users: [] }, optional: null };
  const environment = { USERS: "someone", OPTIONAL: "from-env" };

  assert.deepEqual(setting(source, "permissions.users", "USERS", [], environment), []);
  assert.equal(setting(source, "optional", "OPTIONAL", "fallback", environment), null);
});
