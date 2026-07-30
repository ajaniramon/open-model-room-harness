import assert from "node:assert/strict";
import test from "node:test";
import { VisionAnalyzer, supportedVisionAttachments } from "../src/vision.js";

function visionConfig(overrides = {}) {
  return {
    visionModel: "qwen3.7-flash:thinking",
    visionBaseUrl: "https://nano-gpt.com/api/v1/chat/completions",
    visionTimeoutMs: 5_000,
    visionMaxImages: 4,
    visionMaxBytes: 1_000_000,
    visionMaxOutputTokens: 1_200,
    ...overrides,
  };
}

function discordMessage(attachments) {
  return { attachments: new Map(attachments.map((item, index) => [String(index), item])) };
}

test("selects only supported Discord image attachments", () => {
  const message = discordMessage([
    { name: "photo.png", contentType: "image/png" },
    { name: "document.pdf", contentType: "application/pdf" },
    { name: "fallback.webp", contentType: null },
  ]);
  assert.deepEqual(
    supportedVisionAttachments(message).map((item) => item.name),
    ["photo.png", "fallback.webp"],
  );
});

test("downloads Discord images and sends OpenAI-compatible vision parts", async () => {
  const calls = [];
  const nanoGpt = {
    async complete(messages, options) {
      calls.push({ messages, options });
      return "A red robot is holding a wrench. Text reads BUILD.";
    },
  };
  const analyzer = new VisionAnalyzer(
    visionConfig(),
    nanoGpt,
    async () =>
      new Response(Buffer.from([0x89, 0x50, 0x4e, 0x47]), {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
  );
  const message = discordMessage([
    {
      name: "robot.png",
      contentType: "image/png",
      size: 4,
      url: "https://cdn.discordapp.com/attachments/test/robot.png",
    },
  ]);

  const result = await analyzer.analyze(message, "@JJ what is this?");

  assert.match(result, /red robot/);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].options, {
    provider: "nanogpt",
    model: "qwen3.7-flash:thinking",
    baseUrl: "https://nano-gpt.com/api/v1/chat/completions",
    reasoningEffort: "low",
    maxOutputTokens: 1_200,
  });
  const parts = calls[0].messages[1].content;
  assert.equal(parts[0].type, "text");
  assert.match(parts[0].text, /what is this/);
  assert.equal(parts[1].type, "image_url");
  assert.match(parts[1].image_url.url, /^data:image\/png;base64,/);
});

test("rejects oversized images before downloading or calling NanoGPT", async () => {
  let fetchCalls = 0;
  let modelCalls = 0;
  const analyzer = new VisionAnalyzer(
    visionConfig({ visionMaxBytes: 100 }),
    { async complete() { modelCalls += 1; } },
    async () => {
      fetchCalls += 1;
      return new Response();
    },
  );
  const message = discordMessage([
    {
      name: "huge.png",
      contentType: "image/png",
      size: 101,
      url: "https://cdn.discordapp.com/attachments/test/huge.png",
    },
  ]);

  await assert.rejects(analyzer.analyze(message), /exceeds the 100-byte vision limit/);
  assert.equal(fetchCalls, 0);
  assert.equal(modelCalls, 0);
});
