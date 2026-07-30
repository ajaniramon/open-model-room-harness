import assert from "node:assert/strict";
import test from "node:test";
import { TavilyClient, WebToolRuntime } from "../src/web-tools.js";

test("ports the Tavily advanced-search request and formatted result contract", async () => {
  let request;
  const mockFetch = async (url, options) => {
    request = { url, options, body: JSON.parse(options.body) };
    return new Response(
      JSON.stringify({
        answer: "A synthesized answer",
        results: [
          {
            title: "Official result",
            url: "https://example.com",
            content: "  useful   snippet  ",
          },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
  const result = await new TavilyClient("tvly-test", mockFetch).search("latest fact", 99);
  assert.equal(request.url, "https://api.tavily.com/search");
  assert.deepEqual(request.body, {
    api_key: "tvly-test",
    query: "latest fact",
    max_results: 10,
    search_depth: "advanced",
    include_answer: true,
  });
  assert.equal(
    result,
    "Answer: A synthesized answer\n\n1. Official result\n   https://example.com\n   useful snippet",
  );
});

test("returns recoverable errors for malformed model tool arguments", async () => {
  const runtime = new WebToolRuntime(new TavilyClient("tvly-test"));
  const result = await runtime.call("web_search", "{bad json");
  assert.match(result, /^ERROR: invalid JSON/);
});

test("routes read-only X tools through the shared authorized runtime", async () => {
  const calls = [];
  const fxTwitter = {
    search: async (...args) => (calls.push(["search", ...args]), "search result"),
    fetchPost: async (...args) => (calls.push(["fetch", ...args]), "post result"),
  };
  const runtime = new WebToolRuntime(new TavilyClient("tvly-test"), fxTwitter);
  assert.deepEqual(
    runtime.tools.map((tool) => tool.function.name),
    ["web_search", "web_fetch", "x_search", "x_fetch"],
  );
  assert.equal(
    await runtime.call("x_search", { query: "agents", max_results: 4, feed: "top" }),
    "search result",
  );
  assert.equal(await runtime.call("x_fetch", { post: "123" }), "post result");
  assert.deepEqual(calls, [
    ["search", "agents", 4, "top"],
    ["fetch", "123"],
  ]);
});

test("ports Tavily Extract with clamped output and raw-content formatting", async () => {
  let request;
  const mockFetch = async (url, options) => {
    request = { url, body: JSON.parse(options.body) };
    return new Response(JSON.stringify({ results: [{ raw_content: "Page body" }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  const result = await new TavilyClient("tvly-test", mockFetch).fetchUrl(
    "https://example.com/page",
    100,
  );
  assert.equal(request.url, "https://api.tavily.com/extract");
  assert.deepEqual(request.body, {
    api_key: "tvly-test",
    urls: ["https://example.com/page"],
    extract_depth: "advanced",
  });
  assert.equal(result, "Page body");
});
