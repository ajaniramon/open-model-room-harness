import test from "node:test";
import assert from "node:assert/strict";
import {
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
  assert.doesNotMatch(env, /ANTHROPIC_API_KEY/);
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
