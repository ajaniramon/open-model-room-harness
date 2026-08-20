import assert from "node:assert/strict";
import test from "node:test";
import { ModelClient } from "../src/model-client.js";

function testConfig(provider) {
  return {
    chatProvider: provider,
    modelProviders: {
      none: {
        apiKey: "",
        model: "none",
        baseUrl: "",
      },
      nanogpt: {
        apiKey: "nano-key",
        model: "nano-model",
        baseUrl: "https://nano.test/chat",
      },
      openai: {
        apiKey: "openai-key",
        model: "gpt-5.6-terra",
        baseUrl: "https://api.openai.test/v1/chat/completions",
      },
      anthropic: {
        apiKey: "anthropic-key",
        model: "claude-sonnet-5",
        baseUrl: "https://api.anthropic.test/v1/messages",
      },
      xai: {
        apiKey: "xai-key",
        model: "grok-4.5",
        baseUrl: "https://api.x.test/v1/chat/completions",
      },
      gemini: {
        apiKey: "gemini-key",
        model: "gemini-3.6-flash",
        baseUrl: "https://generativelanguage.test/v1beta",
      },
      local: {
        apiKey: "",
        model: "local-test-model",
        baseUrl: "http://127.0.0.1:8080/v1/chat/completions",
      },
    },
    maxOutputTokens: 256,
    reasoningEffort: "high",
    apiTimeoutMs: 5_000,
    maxToolIterations: 4,
  };
}

test("supports a provider-free Discord connectivity mode", async () => {
  let called = false;
  const fetchMock = async () => {
    called = true;
    return Response.json({});
  };
  const result = await new ModelClient(testConfig("none"), fetchMock).complete([
    { role: "user", content: "Hello" },
  ]);
  assert.match(result, /model disabled/i);
  assert.equal(called, false);
});

test("routes OpenAI through Chat Completions with provider auth", async () => {
  let request;
  const fetchMock = async (url, options) => {
    request = { url, headers: options.headers, body: JSON.parse(options.body) };
    return Response.json({
      choices: [{ message: { role: "assistant", content: "OpenAI answer" } }],
    });
  };
  const result = await new ModelClient(testConfig("openai"), fetchMock).complete([
    { role: "system", content: "System" },
    { role: "user", content: "Hello" },
  ]);
  assert.equal(result, "OpenAI answer");
  assert.equal(request.url, "https://api.openai.test/v1/chat/completions");
  assert.equal(request.headers.Authorization, "Bearer openai-key");
  assert.equal(request.body.model, "gpt-5.6-terra");
  assert.equal(request.body.max_completion_tokens, 256);
});

test("routes xAI through its OpenAI-compatible Chat Completions endpoint", async () => {
  let request;
  const fetchMock = async (url, options) => {
    request = { url, headers: options.headers, body: JSON.parse(options.body) };
    return Response.json({
      choices: [{ message: { role: "assistant", content: "Grok answer" } }],
    });
  };
  const result = await new ModelClient(testConfig("xai"), fetchMock).complete([
    { role: "user", content: "Hello" },
  ]);
  assert.equal(result, "Grok answer");
  assert.equal(request.url, "https://api.x.test/v1/chat/completions");
  assert.equal(request.headers.Authorization, "Bearer xai-key");
  assert.equal(request.body.reasoning_effort, "high");
});

test("routes keyless local llama.cpp and vLLM servers through the minimal OpenAI contract", async () => {
  let request;
  const fetchMock = async (url, options) => {
    request = { url, headers: options.headers, body: JSON.parse(options.body) };
    return Response.json({
      choices: [{ message: { role: "assistant", content: "Local answer" } }],
    });
  };
  const result = await new ModelClient(testConfig("local"), fetchMock).complete([
    { role: "system", content: "System" },
    { role: "user", content: "Hello" },
  ]);
  assert.equal(result, "Local answer");
  assert.equal(request.url, "http://127.0.0.1:8080/v1/chat/completions");
  assert.equal(request.headers.Authorization, undefined);
  assert.equal(request.body.model, "local-test-model");
  assert.equal(request.body.max_tokens, 256);
  assert.equal("reasoning_effort" in request.body, false);
});

test("uses OpenAI's tool-compatible reasoning setting when tools are enabled", async () => {
  let request;
  const fetchMock = async (_url, options) => {
    request = JSON.parse(options.body);
    return Response.json({
      choices: [{ message: { role: "assistant", content: "No call needed" } }],
    });
  };
  const runtime = {
    tools: [
      {
        type: "function",
        function: {
          name: "web_search",
          description: "Search",
          parameters: { type: "object", properties: {} },
        },
      },
    ],
    call: async () => "unused",
  };
  await new ModelClient(testConfig("openai"), fetchMock, runtime).complete(
    [{ role: "user", content: "Hello" }],
    { enabledToolNames: ["web_search"] },
  );
  assert.equal(request.reasoning_effort, "none");
  assert.equal(request.tool_choice, "auto");
});

test("omits OpenAI reasoning controls for non-reasoning chat models", async () => {
  let request;
  const fetchMock = async (_url, options) => {
    request = JSON.parse(options.body);
    return Response.json({
      choices: [{ message: { role: "assistant", content: "Fast answer" } }],
    });
  };
  await new ModelClient(testConfig("openai"), fetchMock).complete(
    [{ role: "user", content: "Hello" }],
    { model: "gpt-4o" },
  );
  assert.equal("reasoning_effort" in request, false);
});

test("translates Anthropic system messages and tool calls", async () => {
  const requests = [];
  const responses = [
    {
      content: [
        {
          type: "tool_use",
          id: "toolu_1",
          name: "web_search",
          input: { query: "launch" },
        },
      ],
      stop_reason: "tool_use",
    },
    {
      content: [{ type: "text", text: "Claude answer" }],
      stop_reason: "end_turn",
    },
  ];
  const fetchMock = async (_url, options) => {
    requests.push({ headers: options.headers, body: JSON.parse(options.body) });
    return Response.json(responses.shift());
  };
  const runtime = {
    tools: [
      {
        type: "function",
        function: {
          name: "web_search",
          description: "Search",
          parameters: { type: "object", properties: { query: { type: "string" } } },
        },
      },
    ],
    call: async () => "Search result",
  };
  const result = await new ModelClient(testConfig("anthropic"), fetchMock, runtime).complete(
    [
      { role: "system", content: "System prompt" },
      { role: "user", content: "Search" },
    ],
    { enabledToolNames: ["web_search"] },
  );
  assert.equal(result, "Claude answer");
  assert.equal(requests[0].headers["x-api-key"], "anthropic-key");
  assert.equal(requests[0].body.system, "System prompt");
  assert.equal(requests[0].body.tools[0].input_schema.type, "object");
  assert.equal(requests[1].body.messages.at(-1).content[0].type, "tool_result");
  assert.equal(requests[1].body.messages.at(-1).content[0].tool_use_id, "toolu_1");
});

test("translates Gemini function calls and preserves thought signatures", async () => {
  const requests = [];
  const signedPart = {
    functionCall: {
      id: "gemini_call_1",
      name: "web_fetch",
      args: { url: "https://example.com" },
    },
    thoughtSignature: "opaque-signature",
  };
  const responses = [
    {
      candidates: [
        {
          content: { role: "model", parts: [signedPart] },
          finishReason: "STOP",
        },
      ],
    },
    {
      candidates: [
        {
          content: { role: "model", parts: [{ text: "Gemini answer" }] },
          finishReason: "STOP",
        },
      ],
    },
  ];
  const fetchMock = async (url, options) => {
    requests.push({ url, headers: options.headers, body: JSON.parse(options.body) });
    return Response.json(responses.shift());
  };
  const runtime = {
    tools: [
      {
        type: "function",
        function: {
          name: "web_fetch",
          description: "Fetch a web page",
          parameters: { type: "object", properties: { url: { type: "string" } } },
        },
      },
    ],
    call: async () => "Page contents",
  };
  const result = await new ModelClient(testConfig("gemini"), fetchMock, runtime).complete(
    [
      { role: "system", content: "System prompt" },
      { role: "user", content: "Fetch the page" },
    ],
    { enabledToolNames: ["web_fetch"] },
  );
  assert.equal(result, "Gemini answer");
  assert.match(requests[0].url, /gemini-3\.6-flash:generateContent$/);
  assert.equal(requests[0].headers["x-goog-api-key"], "gemini-key");
  assert.equal(requests[0].body.systemInstruction.parts[0].text, "System prompt");
  assert.deepEqual(requests[1].body.contents.at(-2).parts[0], signedPart);
  assert.equal(
    requests[1].body.contents.at(-1).parts[0].functionResponse.id,
    "gemini_call_1",
  );
});

test("can override the primary provider for a NanoGPT auxiliary route", async () => {
  let request;
  const fetchMock = async (url, options) => {
    request = { url, headers: options.headers, body: JSON.parse(options.body) };
    return Response.json({
      choices: [{ message: { role: "assistant", content: "NanoGPT sidecar" } }],
    });
  };
  const result = await new ModelClient(testConfig("openai"), fetchMock).complete(
    [{ role: "user", content: "Analyze" }],
    { provider: "nanogpt", model: "vision-model", baseUrl: "https://nano.test/vision" },
  );
  assert.equal(result, "NanoGPT sidecar");
  assert.equal(request.url, "https://nano.test/vision");
  assert.equal(request.headers.Authorization, "Bearer nano-key");
  assert.equal(request.body.model, "vision-model");
});

test("falls back to the configured fallback route when the primary turn fails", async () => {
  const calls = [];
  const fetchMock = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    if (url.startsWith("https://nano.test")) {
      return new Response("upstream exploded", { status: 400 });
    }
    return Response.json({
      choices: [{ message: { role: "assistant", content: "fallback answer" } }],
    });
  };
  const config = {
    ...testConfig("nanogpt"),
    chatFallbackProvider: "openai",
    chatFallbackModel: "",
    chatFallbackBaseUrl: "",
  };
  const result = await new ModelClient(config, fetchMock).complete([
    { role: "user", content: "Hello" },
  ]);
  assert.equal(result, "fallback answer");
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, "https://api.openai.test/v1/chat/completions");
  assert.equal(calls[1].body.model, "gpt-5.6-terra");
});

test("explicit per-call routes fail loudly instead of silently falling back", async () => {
  const config = { ...testConfig("nanogpt"), chatFallbackProvider: "openai" };
  let calls = 0;
  const fetchMock = async () => {
    calls += 1;
    return new Response("nope", { status: 400 });
  };
  await assert.rejects(
    new ModelClient(config, fetchMock).complete([{ role: "user", content: "hi" }], {
      provider: "nanogpt",
      model: "special-model",
      baseUrl: "https://nano.test/special",
    }),
    /HTTP 400/,
  );
  assert.equal(calls, 1, "an explicitly routed call never reroutes to the fallback");
});

test("a semantic failure (tool-iteration cap) does not replay on the fallback", async () => {
  // Primary always asks for a tool; the loop hits maxToolIterations and throws a
  // semantic error, which must NOT re-run the whole turn (and its tools) on fallback.
  let fallbackCalls = 0;
  const fetchMock = async (url) => {
    if (url.startsWith("https://nano.test")) {
      return Response.json({
        choices: [{ message: { role: "assistant", content: null, tool_calls: [
          { id: "c1", type: "function", function: { name: "web_search", arguments: "{}" } },
        ] } }],
      });
    }
    fallbackCalls += 1;
    return Response.json({ choices: [{ message: { role: "assistant", content: "fallback" } }] });
  };
  const runtime = {
    tools: [{ type: "function", function: { name: "web_search", parameters: { type: "object" } } }],
    call: async () => "tool result",
  };
  const config = { ...testConfig("nanogpt"), maxToolIterations: 2, chatFallbackProvider: "openai" };
  await assert.rejects(
    new ModelClient(config, fetchMock, runtime).complete([{ role: "user", content: "search" }], {
      enabledToolNames: ["web_search"],
    }),
    /exceeded 2 tool iterations/,
  );
  assert.equal(fallbackCalls, 0, "the paid tool loop is never replayed on the fallback");
});

test("the circuit breaker routes straight to fallback after repeated primary failures", async () => {
  let clock = 1_000_000;
  const primaryCalls = [];
  const fetchMock = async (url) => {
    if (url.startsWith("https://nano.test")) {
      primaryCalls.push(clock);
      return new Response("down", { status: 503 });
    }
    return Response.json({ choices: [{ message: { role: "assistant", content: "fallback" } }] });
  };
  const config = {
    ...testConfig("nanogpt"),
    chatFallbackProvider: "openai",
    breakerThreshold: 2,
    breakerCooldownMs: 60_000,
  };
  const client = new ModelClient(config, fetchMock, null, { now: () => clock });
  // Two failing turns trip the breaker (each does its own retry, so 2 primary hits/turn).
  await client.complete([{ role: "user", content: "a" }]);
  await client.complete([{ role: "user", content: "b" }]);
  const afterTrip = primaryCalls.length;
  // Third turn: breaker is open, so the primary is skipped entirely.
  const result = await client.complete([{ role: "user", content: "c" }]);
  assert.equal(result, "fallback");
  assert.equal(primaryCalls.length, afterTrip, "no further primary calls while the circuit is open");
});
