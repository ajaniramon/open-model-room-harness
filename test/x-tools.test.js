import assert from "node:assert/strict";
import test from "node:test";
import { FxTwitterClient, KeylessXDiscovery } from "../src/x-tools.js";

test("discovers only validated X post URLs through keyless search HTML", async () => {
  let requestedUrl;
  const discovery = new KeylessXDiscovery(async (url) => {
    requestedUrl = String(url);
    return new Response(
      `<a href="https://r.search.yahoo.com/a/RU=https%3A%2F%2Fx.com%2Fuser%2Fstatus%2F1234567890/RK=2">Post</a>
       <a href="https://example.com/user/status/999999">Reject</a>`,
      { status: 200, headers: { "Content-Type": "text/html" } },
    );
  });

  assert.deepEqual(await discovery.searchPostUrls("local ai", 5), [
    "https://x.com/user/status/1234567890",
  ]);
  assert.match(new URL(requestedUrl).searchParams.get("p"), /^site:x\.com local ai$/);
});

test("searches FxTwitter with bounded results and compact post formatting", async () => {
  let request;
  const mockFetch = async (url, options) => {
    request = { url, options };
    return new Response(
      JSON.stringify({
        code: 200,
        results: [{
          id: "123",
          url: "https://x.com/example/status/123",
          text: "A useful post",
          created_at: "today",
          likes: 7,
          reposts: 3,
          replies: 2,
          views: 42,
          author: { name: "Example", screen_name: "example" },
          media: { photos: [{ url: "https://example.test/photo" }] },
        }],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  const result = await new FxTwitterClient(mockFetch).search("local ai", 99, "top");
  const url = new URL(request.url);
  assert.equal(url.origin + url.pathname, "https://api.fxtwitter.com/2/search");
  assert.equal(url.searchParams.get("q"), "local ai");
  assert.equal(url.searchParams.get("count"), "20");
  assert.equal(url.searchParams.get("feed"), "top");
  assert.equal(request.options.headers.Accept, "application/json");
  assert.match(result, /Example \(@example\)/);
  assert.match(result, /likes 7 \| reposts 3 \| replies 2 \| views 42 \| media 1/);
});

test("fetches a post ID only from supported X URLs", async () => {
  let requestedUrl;
  const mockFetch = async (url) => {
    requestedUrl = url;
    return new Response(
      JSON.stringify({
        code: 200,
        status: {
          id: "1234567890",
          url: "https://x.com/user/status/1234567890",
          text: "Fetched post",
          author: { screen_name: "user" },
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
  const client = new FxTwitterClient(mockFetch);
  const result = await client.fetchPost("https://x.com/user/status/1234567890?s=20");
  assert.equal(requestedUrl, "https://api.fxtwitter.com/2/status/1234567890");
  assert.match(result, /Fetched post/);
  const rejected = await client.fetchPost("https://example.com/user/status/1234567890");
  assert.match(rejected, /^ERROR: post must be/);
});

test("turns FxTwitter API errors into recoverable tool output", async () => {
  const mockFetch = async () =>
    new Response(JSON.stringify({ code: 404, message: "Post not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  const result = await new FxTwitterClient(mockFetch).fetchPost("1234567890");
  assert.equal(result, "ERROR: FxTwitter returned 404: Post not found");
});

test("falls back to free discovery and still fetches structured FxTwitter posts", async () => {
  const requested = [];
  const mockFetch = async (url) => {
    requested.push(String(url));
    if (String(url).includes("/2/search?")) {
      return Response.json(
        { code: 404, results: [], cursor: { top: null, bottom: null } },
        { status: 404 },
      );
    }
    return Response.json({
      code: 200,
      status: {
        id: "1234567890",
        url: "https://x.com/user/status/1234567890",
        text: "Fallback fetched post",
        author: { screen_name: "user" },
      },
    });
  };
  const client = new FxTwitterClient(
    mockFetch,
    "https://api.fxtwitter.test",
    async () => ["https://x.com/user/status/1234567890"],
  );

  const result = await client.search("local ai", 3);
  assert.match(result, /free keyless web-search fallback/);
  assert.match(result, /Fallback fetched post/);
  assert.equal(requested.some((url) => url.endsWith("/2/status/1234567890")), true);
});
