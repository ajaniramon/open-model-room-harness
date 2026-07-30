import assert from "node:assert/strict";
import test from "node:test";
import { NanoGptClient } from "../src/nanogpt.js";

test("executes a tool call and returns the model's synthesized follow-up", async () => {
  const requests = [];
  const responses = [
    {
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "web_search", arguments: "{\"query\":\"news\"}" },
              },
            ],
          },
        },
      ],
    },
    {
      choices: [
        { message: { role: "assistant", content: "Summary with https://example.com" } },
      ],
    },
  ];
  const mockFetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return new Response(JSON.stringify(responses.shift()), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  const runtime = {
    tools: [
      { type: "function", function: { name: "web_search", parameters: { type: "object" } } },
    ],
    call: async () => "1. Source\nhttps://example.com",
  };
  const config = {
    nanoGptModel: "test-model",
    nanoGptBaseUrl: "https://example.test/chat",
    nanoGptApiKey: "secret",
    maxOutputTokens: 100,
    reasoningEffort: "high",
    apiTimeoutMs: 5_000,
    maxToolIterations: 4,
  };
  const result = await new NanoGptClient(config, mockFetch, runtime).complete(
    [{ role: "user", content: "Search the news" }],
    { enabledToolNames: ["web_search"] },
  );
  assert.equal(result, "Summary with https://example.com");
  assert.equal(requests.length, 2);
  assert.equal(requests[0].tool_choice, "auto");
  assert.equal(requests[1].messages.at(-1).role, "tool");
  assert.equal(requests[1].messages.at(-1).tool_call_id, "call_1");
});

test("does not expose tool schemas unless explicitly enabled for the turn", async () => {
  let request;
  const mockFetch = async (_url, options) => {
    request = JSON.parse(options.body);
    return new Response(
      JSON.stringify({ choices: [{ message: { role: "assistant", content: "No tools" } }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
  const runtime = {
    tools: [{ type: "function", function: { name: "web_search" } }],
    call: async () => "must not run",
  };
  const config = {
    nanoGptModel: "test-model",
    nanoGptBaseUrl: "https://example.test/chat",
    nanoGptApiKey: "secret",
    maxOutputTokens: 100,
    reasoningEffort: "high",
    apiTimeoutMs: 5_000,
    maxToolIterations: 4,
  };
  await new NanoGptClient(config, mockFetch, runtime).complete([
    { role: "user", content: "Search the news" },
  ]);
  assert.equal("tools" in request, false);
  assert.equal("tool_choice" in request, false);
});

test("exposes only the specifically authorized tool schemas", async () => {
  let request;
  const mockFetch = async (_url, options) => {
    request = JSON.parse(options.body);
    return new Response(
      JSON.stringify({ choices: [{ message: { role: "assistant", content: "Done" } }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
  const runtime = {
    tools: [
      { type: "function", function: { name: "web_search" } },
      { type: "function", function: { name: "web_fetch" } },
    ],
    call: async () => "must not run",
  };
  const config = {
    nanoGptModel: "test-model",
    nanoGptBaseUrl: "https://example.test/chat",
    nanoGptApiKey: "secret",
    maxOutputTokens: 100,
    reasoningEffort: "high",
    apiTimeoutMs: 5_000,
    maxToolIterations: 4,
  };
  await new NanoGptClient(config, mockFetch, runtime).complete(
    [{ role: "user", content: "Fetch the page" }],
    { enabledToolNames: ["web_fetch"] },
  );
  assert.deepEqual(request.tools.map((tool) => tool.function.name), ["web_fetch"]);
});

test("supports a per-call model, endpoint, reasoning, and token override", async () => {
  let requestUrl;
  let requestBody;
  const mockFetch = async (url, options) => {
    requestUrl = url;
    requestBody = JSON.parse(options.body);
    return new Response(
      JSON.stringify({ choices: [{ message: { role: "assistant", content: "Specialist" } }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
  const config = {
    nanoGptModel: "normal-model",
    nanoGptBaseUrl: "https://normal.test/chat",
    nanoGptApiKey: "secret",
    maxOutputTokens: 100,
    reasoningEffort: "high",
    apiTimeoutMs: 5_000,
    maxToolIterations: 4,
  };
  await new NanoGptClient(config, mockFetch).complete(
    [{ role: "user", content: "Do specialist work" }],
    {
      model: "specialist-model",
      baseUrl: "https://specialist.test/chat",
      reasoningEffort: "none",
      maxOutputTokens: 321,
    },
  );
  assert.equal(requestUrl, "https://specialist.test/chat");
  assert.equal(requestBody.model, "specialist-model");
  assert.equal(requestBody.reasoning_effort, "none");
  assert.equal(requestBody.max_tokens, 321);
});

test("retries one empty model response before returning visible content", async () => {
  let calls = 0;
  const mockFetch = async () => {
    calls += 1;
    const message = calls === 1 ? { role: "assistant", content: "" } : { role: "assistant", content: "Recovered" };
    return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  const config = {
    nanoGptModel: "test-model",
    nanoGptBaseUrl: "https://example.test/chat",
    nanoGptApiKey: "secret",
    maxOutputTokens: 100,
    reasoningEffort: "high",
    apiTimeoutMs: 5_000,
    maxToolIterations: 4,
  };
  const result = await new NanoGptClient(config, mockFetch).complete([
    { role: "user", content: "Hello" },
  ]);
  assert.equal(result, "Recovered");
  assert.equal(calls, 2);
});
