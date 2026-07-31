import assert from "node:assert/strict";
import test from "node:test";
import { config } from "../src/config.js";

test("configures all supported primary conversation providers", () => {
  assert.equal(config.chatProvider, "nanogpt");
  assert.equal(config.modelProviders.openai.model, "gpt-5.6-terra");
  assert.equal(config.modelProviders.anthropic.model, "claude-sonnet-5");
  assert.equal(config.modelProviders.xai.model, "grok-4.5");
  assert.equal(config.modelProviders.gemini.model, "gemini-3.6-flash");
  assert.equal(config.modelProviders.local.model, "local-model");
  assert.equal(
    config.modelProviders.local.baseUrl,
    "http://127.0.0.1:8080/v1/chat/completions",
  );
});

test("routes Kimi K3 escalation aliases through NanoGPT paid API", () => {
  const expected = {
    provider: "nanogpt",
    model: "moonshotai/kimi-k3",
    baseUrl: "https://nano-gpt.com/api/v1/chat/completions",
    reasoningEffort: "high",
    billing: "paid",
  };

  assert.deepEqual(config.escalationModels["kimi-k3"], expected);
  assert.equal(config.escalationModels["kimi k3"], config.escalationModels["kimi-k3"]);
  assert.equal(config.escalationModels.k3, config.escalationModels["kimi-k3"]);
  assert.equal(
    config.escalationModels["moonshotai/kimi-k3"],
    config.escalationModels["kimi-k3"],
  );
});

test("routes Grok 4.5 escalation aliases through NanoGPT paid API", () => {
  const expected = {
    provider: "nanogpt",
    model: "x-ai/grok-4.5",
    baseUrl: "https://nano-gpt.com/api/v1/chat/completions",
    reasoningEffort: "high",
    billing: "paid",
  };

  assert.deepEqual(config.escalationModels["grok-4.5"], expected);
  assert.equal(config.escalationModels["grok 4.5"], config.escalationModels["grok-4.5"]);
  assert.equal(config.escalationModels.grok45, config.escalationModels["grok-4.5"]);
  assert.equal(
    config.escalationModels["x-ai/grok-4.5"],
    config.escalationModels["grok-4.5"],
  );
});

test("defaults image generation to GPT Image 2", () => {
  assert.equal(config.imageApiBaseUrl, "https://nano-gpt.com/api/v1");
  assert.equal(config.imageDefaultModel, "gpt-image-2");
  assert.equal(config.imagePromptModel, "qwen3.7-flash:thinking");
  assert.equal(config.imageAllowedUsernames.size, 0);
});

test("uses a capable Chinese vision sidecar because MiMo is text-only", () => {
  assert.equal(config.visionModel, "qwen3.7-flash:thinking");
  assert.equal(config.visionBaseUrl, "https://nano-gpt.com/api/v1/chat/completions");
  assert.equal(config.visionMaxImages, 4);
});
