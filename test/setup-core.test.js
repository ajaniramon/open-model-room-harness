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
  assert.equal(buildConfigJson(config).includes("discord-test-value"), false);
  assert.equal(buildConfigJson(config).includes("provider-test-value"), false);
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
