import test from "node:test";
import assert from "node:assert/strict";
import {
  buildConfigJson,
  buildEnvText,
  providerDefinitions,
  validateSetup,
} from "../scripts/setup-core.js";

function valid(overrides = {}) {
  return {
    provider: "openai",
    discordToken: "discord-test-value",
    primaryApiKey: "provider-test-value",
    model: "gpt-test",
    ownerId: "123456789012345678",
    ...overrides,
  };
}

test("validates every GUI provider and applies safe defaults", () => {
  for (const [provider, definition] of Object.entries(providerDefinitions)) {
    const config = validateSetup(valid({ provider, model: definition.defaultModel }));
    assert.equal(config.provider, provider);
    assert.equal(config.model, definition.defaultModel);
    assert.equal(config.runTests, true);
    assert.equal(config.replaceExisting, false);
  }
});

test("requires secrets and an owner identity", () => {
  assert.throws(() => validateSetup(valid({ discordToken: "" })), /Discord bot token/);
  assert.throws(() => validateSetup(valid({ primaryApiKey: "" })), /API key/);
  assert.throws(() => validateSetup(valid({ ownerId: "", ownerUsername: "" })), /owner/);
  assert.throws(() => validateSetup(valid({ ownerId: "not-an-id" })), /15–22 digits/);
});

test("builds an owner-gated env without leaking unrelated provider variables", () => {
  const config = validateSetup(valid({ ownerUsername: "_operator" }));
  const env = buildEnvText(config);
  assert.match(env, /MODEL_PROVIDER="openai"/);
  assert.match(env, /OPENAI_API_KEY="provider-test-value"/);
  assert.match(env, /JJ_CODEX_ALLOWED_USER_IDS="123456789012345678"/);
  assert.match(env, /JJ_IMAGE_ALLOWED_USERNAMES="_operator"/);
  assert.match(env, /JJ_OWNER_USER_IDS="123456789012345678"/);
  assert.doesNotMatch(env, /ANTHROPIC_API_KEY/);
});

test("builds a secret-free config.json with participation controls", () => {
  const config = validateSetup(valid({
    budgetMaxResponses: "18",
    conversationTurns: "4",
    cooldownMaxSeconds: "90",
    autobanEnabled: false,
  }));
  const payload = JSON.parse(buildConfigJson(config));
  assert.equal(payload.participation.budget.maxResponses, 18);
  assert.equal(payload.participation.conversation.turns, 4);
  assert.equal(payload.participation.cooldown.maxSeconds, 90);
  assert.equal(payload.participation.autoban.enabled, false);
  assert.deepEqual(payload.permissions.owner.allowedUserIds, ["123456789012345678"]);
  assert.equal(payload.runtimeControl.restartEnabled, false);
  assert.equal(payload.logging.runtimeControl.path, "logs/runtime-control.jsonl");
  assert.equal(buildConfigJson(config).includes("discord-test-value"), false);
  assert.equal(buildConfigJson(config).includes("provider-test-value"), false);
});

test("enables supervised restart only with an immutable numeric owner ID", () => {
  const payload = JSON.parse(buildConfigJson(validateSetup(valid({ runtimeRestartEnabled: true }))));
  assert.equal(payload.runtimeControl.restartEnabled, true);
  assert.throws(
    () => validateSetup(valid({ ownerId: "", ownerUsername: "operator", runtimeRestartEnabled: true })),
    /numeric owner Discord user ID/,
  );
});

test("rejects invalid participation values from the installer", () => {
  assert.throws(() => validateSetup(valid({ conversationTurns: "0" })), /Conversation turns/);
  assert.throws(() => validateSetup(valid({ budgetMaxResponses: "many" })), /Global response budget/);
  assert.throws(
    () => validateSetup(valid({ cooldownBaseSeconds: "30", cooldownMaxSeconds: "10" })),
    /Cooldown maximum/,
  );
});

test("writes a validated time zone and enables message timestamps", () => {
  const env = buildEnvText(validateSetup(valid({ timeZone: "Europe/Madrid" })));
  assert.match(env, /JJ_CONTEXT_TIMESTAMPS="true"/);
  assert.match(env, /JJ_TIME_ZONE="Europe\/Madrid"/);
  assert.equal(
    validateSetup(valid({ timeZone: "" })).timeZone,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  assert.throws(() => validateSetup(valid({ timeZone: "Mars/Olympus_Mons" })), /time zone/);
});

test("memory ships disabled and only turns on when the operator asks", () => {
  const off = buildEnvText(validateSetup(valid()));
  assert.match(off, /JJ_MEMORY_ENABLED="false"/);
  assert.match(off, /JJ_MEMORY_EXTRACTION_ENABLED="false"/);
  assert.match(off, /JJ_MEMORY_ALLOWED_USER_IDS=""/);
  assert.equal(JSON.parse(buildConfigJson(validateSetup(valid()))).memory.enabled, false);

  const on = validateSetup(valid({ enableMemory: true, enableMemoryCapture: true }));
  const env = buildEnvText(on);
  assert.match(env, /JJ_MEMORY_ENABLED="true"/);
  assert.match(env, /JJ_MEMORY_EXTRACTION_ENABLED="true"/);
  assert.match(env, /JJ_MEMORY_CAPTURE_MODE="observation"/);
  const json = JSON.parse(buildConfigJson(on));
  assert.equal(json.memory.enabled, true);
  assert.deepEqual(json.permissions.memory.allowedUserIds, ["123456789012345678"]);
});

test("X link prefetch ships enabled and can be turned off at install time", () => {
  const on = JSON.parse(buildConfigJson(validateSetup(valid())));
  assert.equal(on.xPrefetch.enabled, true);
  assert.equal(on.xPrefetch.maxPosts, 2);

  const off = validateSetup(valid({ enableXPrefetch: false }));
  assert.equal(off.enableXPrefetch, false);
  assert.equal(JSON.parse(buildConfigJson(off)).xPrefetch.enabled, false);
});

test("passive capture cannot be enabled without memory itself", () => {
  const config = validateSetup(valid({ enableMemoryCapture: true }));
  assert.equal(config.enableMemory, false);
  assert.equal(config.enableMemoryCapture, false);
  assert.match(buildEnvText(config), /JJ_MEMORY_EXTRACTION_ENABLED="false"/);
});

test("reuses the primary key as the NanoGPT sidecar when NanoGPT is primary", () => {
  const config = validateSetup(valid({ provider: "nanogpt" }));
  assert.equal(config.nanoGptApiKey, config.primaryApiKey);
});

test("accepts a keyless local server and writes its normalized OpenAI-compatible route", () => {
  const config = validateSetup(
    valid({
      provider: "local",
      primaryApiKey: "",
      model: "my-local-model",
      baseUrl: "http://127.0.0.1:8000/v1/chat/completions",
    }),
  );
  const env = buildEnvText(config);
  assert.equal(config.baseUrl, "http://127.0.0.1:8000/v1");
  assert.match(env, /MODEL_PROVIDER="local"/);
  assert.match(env, /LOCAL_API_KEY=""/);
  assert.match(env, /LOCAL_MODEL="my-local-model"/);
  assert.match(env, /LOCAL_BASE_URL="http:\/\/127\.0\.0\.1:8000\/v1"/);
});
