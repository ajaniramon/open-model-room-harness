import test from "node:test";
import assert from "node:assert/strict";
import { listProviderModels } from "../scripts/model-catalog.js";

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

test("normalizes NanoGPT subscription models", async () => {
  const models = await listProviderModels("nanogpt", "test-key", {
    fetchImpl: async (url, options) => {
      assert.match(url, /subscription\/v1\/models/);
      assert.equal(options.headers.Authorization, "Bearer test-key");
      return response({ data: [{ id: "kimi-k3" }, { id: "mimo-pro" }] });
    },
  });
  assert.deepEqual(models, ["kimi-k3", "mimo-pro"]);
});

test("filters non-chat OpenAI models", async () => {
  const models = await listProviderModels("openai", "test-key", {
    fetchImpl: async () =>
      response({
        data: [
          { id: "gpt-5.6-terra" },
          { id: "gpt-realtime" },
          { id: "text-embedding-3-large" },
          { id: "o4-mini" },
        ],
      }),
  });
  assert.deepEqual(models, ["gpt-5.6-terra", "o4-mini"]);
});

test("normalizes Anthropic and xAI catalogs", async () => {
  const anthropic = await listProviderModels("anthropic", "test-key", {
    fetchImpl: async (_url, options) => {
      assert.equal(options.headers["anthropic-version"], "2023-06-01");
      return response({ data: [{ id: "claude-sonnet-test" }] });
    },
  });
  const xai = await listProviderModels("xai", "test-key", {
    fetchImpl: async () =>
      response({ data: [{ id: "grok-test" }, { id: "grok-image-test" }] }),
  });
  assert.deepEqual(anthropic, ["claude-sonnet-test"]);
  assert.deepEqual(xai, ["grok-test"]);
});

test("keeps only Gemini generateContent models and strips resource prefixes", async () => {
  const models = await listProviderModels("gemini", "test-key", {
    fetchImpl: async (url) => {
      assert.match(url, /key=test-key/);
      return response({
        models: [
          {
            name: "models/gemini-chat-test",
            supportedGenerationMethods: ["generateContent"],
          },
          {
            name: "models/gemini-embedding-test",
            supportedGenerationMethods: ["embedContent"],
          },
        ],
      });
    },
  });
  assert.deepEqual(models, ["gemini-chat-test"]);
});

test("returns useful catalog errors without echoing credentials", async () => {
  await assert.rejects(
    () =>
      listProviderModels("openai", "secret-value", {
        fetchImpl: async () => response({}, 401),
      }),
    (error) => {
      assert.match(error.message, /rejected/);
      assert.doesNotMatch(error.message, /secret-value/);
      return true;
    },
  );
});
