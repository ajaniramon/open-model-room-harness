import assert from "node:assert/strict";
import test from "node:test";
import {
  FxTwitterClient,
  KeylessXDiscovery,
  XPostPrefetcher,
  extractXPostUrls,
} from "../src/x-tools.js";

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

test("extracts only real X post links from surrounding message text", () => {
  assert.deepEqual(extractXPostUrls("@bot https://x.com/jack/status/20"), [
    "https://x.com/jack/status/20",
  ]);
  assert.deepEqual(extractXPostUrls("look at <https://twitter.com/jack/status/123>"), [
    "https://x.com/jack/status/123",
  ]);
  assert.deepEqual(extractXPostUrls("(https://fixupx.com/jack/status/456)."), [
    "https://x.com/jack/status/456",
  ]);
  assert.deepEqual(extractXPostUrls("www.x.com/jack/status/789 thoughts?"), [
    "https://x.com/jack/status/789",
  ]);
  // Hosts that merely contain an allowed name, and redirects that carry one in the
  // query string, must not be treated as X posts.
  assert.deepEqual(extractXPostUrls("https://fox.com/news/status/2020"), []);
  assert.deepEqual(extractXPostUrls("https://notx.com/a/status/1234"), []);
  assert.deepEqual(extractXPostUrls("https://mytwitter.com/a/status/1234"), []);
  assert.deepEqual(extractXPostUrls("https://evil.com/r?u=x.com/a/status/12345"), []);
  assert.deepEqual(extractXPostUrls("https://x.com/jack"), []);
  assert.deepEqual(extractXPostUrls("no links here"), []);
});

test("deduplicates linked posts and honours the configured maximum", () => {
  const content =
    "https://x.com/a/status/111 https://twitter.com/b/status/111 " +
    "https://x.com/c/status/222 https://x.com/d/status/333";
  assert.deepEqual(extractXPostUrls(content, 2), [
    "https://x.com/a/status/111",
    "https://x.com/c/status/222",
  ]);
});

test("prefetches linked posts and reports failures instead of inventing content", async () => {
  const fetched = [];
  const prefetcher = new XPostPrefetcher({
    client: {
      async fetchPost(url) {
        fetched.push(url);
        if (url.endsWith("/999")) return "ERROR: FxTwitter returned 404: not found";
        return "@jack — today\nA downloaded post\nlikes 7";
      },
    },
    maxPosts: 2,
  });

  const block = await prefetcher.describe(
    "look https://x.com/jack/status/20 and https://x.com/jack/status/999",
  );
  assert.deepEqual(fetched, [
    "https://x.com/jack/status/20",
    "https://x.com/jack/status/999",
  ]);
  assert.match(block, /A downloaded post/);
  assert.match(block, /not downloaded: FxTwitter returned 404: not found/);
  assert.equal(await prefetcher.describe("no links here"), null);
});

test("clamps prefetched post text to the configured budget", async () => {
  const prefetcher = new XPostPrefetcher({
    client: { async fetchPost() { return "x".repeat(5_000); } },
    maxChars: 300,
  });
  const block = await prefetcher.describe("https://x.com/jack/status/20");
  assert.equal(block.length <= 300 + "\n… (X post text truncated)".length, true);
  assert.match(block, /X post text truncated/);
});

test("a prefetcher without a client stays inert", async () => {
  assert.equal(await new XPostPrefetcher().describe("https://x.com/jack/status/20"), null);
});
