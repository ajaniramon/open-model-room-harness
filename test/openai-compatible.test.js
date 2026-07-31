import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeOpenAiCompatibleBaseUrl,
  openAiCompatibleChatUrl,
  openAiCompatibleModelsUrl,
} from "../src/openai-compatible.js";

test("normalizes llama.cpp and vLLM endpoint forms", () => {
  assert.equal(
    normalizeOpenAiCompatibleBaseUrl("http://127.0.0.1:8080"),
    "http://127.0.0.1:8080/v1",
  );
  assert.equal(
    normalizeOpenAiCompatibleBaseUrl("http://127.0.0.1:8000/v1/chat/completions"),
    "http://127.0.0.1:8000/v1",
  );
  assert.equal(
    openAiCompatibleChatUrl("http://localhost:8080/v1"),
    "http://localhost:8080/v1/chat/completions",
  );
  assert.equal(
    openAiCompatibleModelsUrl("http://localhost:8080"),
    "http://localhost:8080/v1/models",
  );
});

test("rejects unsafe or credential-bearing local endpoint values", () => {
  assert.throws(() => normalizeOpenAiCompatibleBaseUrl("file:///tmp/model"), /http/);
  assert.throws(
    () => normalizeOpenAiCompatibleBaseUrl("http://user:pass@localhost:8080/v1"),
    /credentials/,
  );
});
