import assert from "node:assert/strict";
import test from "node:test";
import { NanoGptImageClient } from "../src/image-generation.js";

function imageConfig(overrides = {}) {
  return {
    nanoGptApiKey: "test-key",
    imageApiBaseUrl: "https://nano-gpt.com/api/v1",
    imageDefaultModel: "gpt-image-2",
    imageTimeoutMs: 5_000,
    imageMaxPromptChars: 3_000,
    imageMaxBytes: 1_000_000,
    ...overrides,
  };
}

function base64ImageResponse() {
  return new Response(
    JSON.stringify({
      data: [{ b64_json: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64") }],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

test("generates one base64 image with the configured default model", async () => {
  const calls = [];
  const client = new NanoGptImageClient(imageConfig(), async (url, options) => {
    calls.push({ url, options });
    return base64ImageResponse();
  });

  const result = await client.generate({ prompt: "A tiny robot holding a wrench" });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://nano-gpt.com/api/v1/images/generations");
  assert.equal(calls[0].options.headers.Authorization, "Bearer test-key");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    model: "gpt-image-2",
    prompt: "A tiny robot holding a wrench",
    n: 1,
    response_format: "b64_json",
  });
  assert.equal(result.model, "gpt-image-2");
  assert.equal(result.images.length, 1);
  assert.equal(result.images[0].extension, "png");
  assert.deepEqual([...result.images[0].buffer], [0x89, 0x50, 0x4e, 0x47]);
});

test("accepts any exact image-capable model from NanoGPT's live catalog", async () => {
  const calls = [];
  const client = new NanoGptImageClient(imageConfig(), async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith("/images/models")) {
      return new Response(
        JSON.stringify({
          data: [{ id: "ideogram/v4/fast", capabilities: { image_generation: true } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return base64ImageResponse();
  });

  const result = await client.generate({
    prompt: "A clean technical poster",
    requestedModel: "ideogram/v4/fast",
  });

  assert.equal(calls.length, 2);
  assert.ok(calls[0].url.endsWith("/images/models"));
  assert.equal(JSON.parse(calls[1].options.body).model, "ideogram/v4/fast");
  assert.equal(result.model, "ideogram/v4/fast");
});

test("rejects unknown model IDs before starting paid generation", async () => {
  let generationCalls = 0;
  const client = new NanoGptImageClient(imageConfig(), async (url) => {
    if (url.endsWith("/images/models")) {
      return new Response(JSON.stringify({ data: [{ id: "known-image-model" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    generationCalls += 1;
    return base64ImageResponse();
  });

  await assert.rejects(
    client.generate({ prompt: "test", requestedModel: "imaginary/expensive-v9000" }),
    /not present in NanoGPT's live image catalog/,
  );
  assert.equal(generationCalls, 0);
});
