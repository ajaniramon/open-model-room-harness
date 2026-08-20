import { boundedFetch } from "./http.js";
import { isRetryableRequestError, retry } from "./retry.js";

export const X_SEARCH_TOOL = Object.freeze({
  type: "function",
  function: {
    name: "x_search",
    description:
      "Search public X/Twitter posts with FxTwitter. Use only when a participant explicitly asks to search X/Twitter. Returns compact post text, author, engagement, date, and URL.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "X/Twitter search query, including supported search operators.",
        },
        max_results: {
          type: "integer",
          description: "How many posts to return (1-20, default 10).",
        },
        feed: {
          type: "string",
          enum: ["latest", "top", "media"],
          description: "Search tab to use (default latest).",
        },
      },
      required: ["query"],
    },
  },
});

export const X_FETCH_TOOL = Object.freeze({
  type: "function",
  function: {
    name: "x_fetch",
    description:
      "Fetch one public X/Twitter post with FxTwitter. Accepts an x.com/twitter.com/fxtwitter.com post URL or its numeric post ID.",
    parameters: {
      type: "object",
      properties: {
        post: {
          type: "string",
          description: "A public X/Twitter post URL or numeric post ID.",
        },
      },
      required: ["post"],
    },
  },
});

const X_POST_HOSTS = Object.freeze(
  new Set([
    "x.com",
    "www.x.com",
    "twitter.com",
    "www.twitter.com",
    "fxtwitter.com",
    "www.fxtwitter.com",
    "fixupx.com",
    "www.fixupx.com",
  ]),
);

// Only used to skip obvious non-candidates cheaply. The host allowlist below is the
// actual check, because a substring match would accept hosts like "notx.com".
const X_POST_CANDIDATE =
  /^(?:https?:\/\/)?(?:[a-z0-9-]+\.)*(?:x|twitter|fxtwitter|fixupx)\.com\//i;

function postId(value) {
  if (typeof value !== "string") return "";
  const input = value.trim();
  if (/^\d{2,20}$/.test(input)) return input;
  try {
    const url = new URL(input);
    if (!X_POST_HOSTS.has(url.hostname.toLowerCase())) return "";
    return url.pathname.match(/\/status\/(\d{2,20})(?:\/|$)/)?.[1] || "";
  } catch {
    return "";
  }
}

// Discord suppresses embeds with <angle brackets> and people glue links to
// punctuation, so candidates are split and trimmed before being parsed as URLs
// instead of being pattern-matched inside the raw message text.
export function extractXPostUrls(content, maxUrls = 2) {
  const limit = Math.max(1, Math.min(Number(maxUrls) || 1, 5));
  const urls = [];
  const seen = new Set();
  for (const token of String(content || "").split(/[\s<>"'`]+/)) {
    if (!token) continue;
    const candidate = token.replace(/^[([{]+/, "").replace(/[),.;:!?\]}]+$/, "");
    if (!X_POST_CANDIDATE.test(candidate)) continue;
    let url;
    try {
      url = new URL(/^https?:\/\//i.test(candidate) ? candidate : `https://${candidate}`);
    } catch {
      continue;
    }
    if (!X_POST_HOSTS.has(url.hostname.toLowerCase())) continue;
    const match = url.pathname.match(/^\/([A-Za-z0-9_]{1,20})\/status\/(\d{2,20})(?:\/|$)/);
    if (!match) continue;
    if (seen.has(match[2])) continue;
    seen.add(match[2]);
    urls.push(`https://x.com/${match[1]}/status/${match[2]}`);
    if (urls.length >= limit) break;
  }
  return urls;
}

function decodeHtmlAttribute(value) {
  return String(value || "")
    .replaceAll("&amp;", "&")
    .replaceAll("&#x2F;", "/")
    .replaceAll("&#47;", "/")
    .replaceAll("&quot;", '"');
}

function discoveredPostUrl(value) {
  try {
    let candidate = decodeHtmlAttribute(value);
    if (candidate.startsWith("//")) candidate = `https:${candidate}`;
    let url = new URL(candidate);
    if (
      new Set(["duckduckgo.com", "www.duckduckgo.com", "html.duckduckgo.com"]).has(
        url.hostname.toLowerCase(),
      ) &&
      url.pathname === "/l/"
    ) {
      candidate = url.searchParams.get("uddg") || "";
      url = new URL(candidate);
    }
    if (!new Set(["x.com", "www.x.com", "twitter.com", "www.twitter.com"]).has(
      url.hostname.toLowerCase(),
    )) {
      return "";
    }
    const match = url.pathname.match(/^\/([^/]+)\/status\/(\d{2,20})(?:\/|$)/);
    return match ? `https://x.com/${match[1]}/status/${match[2]}` : "";
  } catch {
    return "";
  }
}

export class KeylessXDiscovery {
  constructor(fetchImplementation = fetch) {
    this.fetch = fetchImplementation;
  }

  async fetchHtml(url, provider) {
    return retry(
      () =>
        boundedFetch(url, {
          fetchImpl: this.fetch,
          timeoutMs: 20_000,
          parse: "text",
          maxBytes: 2_000_000,
          label: `${provider} request`,
          headers: {
            Accept: "text/html",
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
          },
        }),
      // A search engine serving a 403/captcha to the datacenter IP is deterministic;
      // only transport-shaped failures are worth a second 20 s attempt.
      { attempts: 2, backoffMs: 0, shouldRetry: isRetryableRequestError, label: `${provider} request` },
    );
  }

  yahooUrls(html, count) {
    const urls = [];
    for (const anchor of html.match(/<a\b[^>]*href=["'][^"']+["'][^>]*>/gi) || []) {
      const href = decodeHtmlAttribute(anchor.match(/\bhref=["']([^"']+)["']/i)?.[1]);
      const redirectTarget = href.match(/\/RU=([^/]+)\/RK=/i)?.[1];
      let candidate = href;
      if (redirectTarget) {
        try {
          candidate = decodeURIComponent(redirectTarget);
        } catch {
          continue;
        }
      }
      const normalized = discoveredPostUrl(candidate);
      if (normalized && !urls.includes(normalized)) urls.push(normalized);
      if (urls.length >= count) break;
    }
    return urls;
  }

  duckDuckGoUrls(html, count) {
    if (/anomaly-modal|captcha|challenge-form/i.test(html)) return [];
    const urls = [];
    for (const anchor of html.match(/<a\b[^>]*class=["'][^"']*\bresult__a\b[^"']*["'][^>]*>/gi) || []) {
      const href = anchor.match(/\bhref=["']([^"']+)["']/i)?.[1];
      const normalized = discoveredPostUrl(href);
      if (normalized && !urls.includes(normalized)) urls.push(normalized);
      if (urls.length >= count) break;
    }
    return urls;
  }

  async searchPostUrls(query, maxResults = 10) {
    if (typeof query !== "string" || !query.trim()) {
      throw new Error("query must be a non-empty string.");
    }
    let count = Number.parseInt(maxResults || 10, 10);
    if (!Number.isFinite(count)) count = 10;
    count = Math.max(1, Math.min(count, 20));
    const searchQuery = `site:x.com ${query.trim()}`;
    const failures = [];

    try {
      const yahooUrl = new URL("https://search.yahoo.com/search");
      yahooUrl.search = new URLSearchParams({ p: searchQuery, n: String(count) });
      const yahooUrls = this.yahooUrls(await this.fetchHtml(yahooUrl, "Yahoo Search"), count);
      if (yahooUrls.length) return yahooUrls;
      failures.push("Yahoo Search returned no post URLs");
    } catch (error) {
      failures.push(error.message || String(error));
    }

    try {
      const duckUrl = new URL("https://html.duckduckgo.com/html/");
      duckUrl.search = new URLSearchParams({ q: searchQuery });
      const duckUrls = this.duckDuckGoUrls(
        await this.fetchHtml(duckUrl, "DuckDuckGo"),
        count,
      );
      if (duckUrls.length) return duckUrls;
      failures.push("DuckDuckGo returned no post URLs");
    } catch (error) {
      failures.push(error.message || String(error));
    }

    throw new Error(failures.join("; "));
  }
}

export { KeylessXDiscovery as DuckDuckGoXDiscovery };

function oneLine(value, maxLength = 700) {
  const text = String(value || "").split(/\s+/).filter(Boolean).join(" ");
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

function formatPost(post, index) {
  const author = post?.author || {};
  const handle = oneLine(author.screen_name, 50) || "unknown";
  const name = oneLine(author.name, 100);
  const identity = name && name !== handle ? `${name} (@${handle})` : `@${handle}`;
  const metrics = [
    `likes ${Number(post?.likes) || 0}`,
    `reposts ${Number(post?.reposts) || 0}`,
    `replies ${Number(post?.replies) || 0}`,
    Number.isFinite(post?.views) ? `views ${post.views}` : "",
  ].filter(Boolean);
  const mediaCount = Array.isArray(post?.media?.all)
    ? post.media.all.length
    : (post?.media?.photos?.length || 0) + (post?.media?.videos?.length || 0);
  if (mediaCount) metrics.push(`media ${mediaCount}`);
  const prefix = index === undefined ? "" : `${index + 1}. `;
  return [
    `${prefix}${identity} — ${oneLine(post?.created_at, 100) || "date unknown"}`,
    oneLine(post?.text) || "(no text)",
    metrics.join(" | "),
    String(post?.url || (post?.id ? `https://x.com/i/status/${post.id}` : "")),
  ]
    .filter(Boolean)
    .join("\n");
}

export class FxTwitterClient {
  constructor(
    fetchImplementation = fetch,
    baseUrl = "https://api.fxtwitter.com",
    discoverPostUrls = null,
  ) {
    this.fetch = fetchImplementation;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.discoverPostUrls = discoverPostUrls;
  }

  async request(path) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    try {
      const response = await this.fetch(`${this.baseUrl}${path}`, {
        headers: {
          Accept: "application/json",
          "User-Agent":
            "OpenModelRoomHarness/1.3 (+https://github.com/ajaniramon/open-model-room-harness)",
        },
        signal: controller.signal,
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data || data.code >= 400) {
        const detail = oneLine(data?.message || response.statusText || "request failed", 200);
        return {
          error: `ERROR: FxTwitter returned ${data?.code || response.status}: ${detail}`,
          status: Number(data?.code || response.status),
          data,
        };
      }
      return { data };
    } catch (error) {
      return {
        error: `ERROR: X/Twitter request failed: ${error.name || "Error"}: ${
          error.message || error
        }`,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  async search(query, maxResults = 10, feed = "latest") {
    if (typeof query !== "string" || !query.trim()) {
      return "ERROR: query must be a non-empty string.";
    }
    if (query.trim().length > 500) return "ERROR: query must not exceed 500 characters.";
    let count = Number.parseInt(maxResults || 10, 10);
    if (!Number.isFinite(count)) count = 10;
    count = Math.max(1, Math.min(count, 20));
    const selectedFeed = new Set(["latest", "top", "media"]).has(feed) ? feed : "latest";
    const params = new URLSearchParams({ q: query.trim(), count: String(count), feed: selectedFeed });
    const result = await this.request(`/2/search?${params}`);
    if (result.error) {
      const emptySearch =
        result.status === 404 &&
        Array.isArray(result.data?.results) &&
        result.data.results.length === 0;
      if (emptySearch && this.discoverPostUrls) {
        return this.searchWithDiscoveryFallback(query.trim(), count);
      }
      return result.error;
    }
    const posts = Array.isArray(result.data.results) ? result.data.results.slice(0, count) : [];
    if (!posts.length && this.discoverPostUrls) {
      return this.searchWithDiscoveryFallback(query.trim(), count);
    }
    return posts.map((post, index) => formatPost(post, index)).join("\n\n") || "(no X posts found)";
  }

  async searchWithDiscoveryFallback(query, count) {
    try {
      const urls = await this.discoverPostUrls(query, count);
      if (!Array.isArray(urls) || !urls.length) return "(no X posts found)";
      const fetched = await Promise.all(urls.slice(0, count).map((url) => this.fetchPost(url)));
      const posts = fetched.filter((post) => post && !post.startsWith("ERROR:"));
      if (!posts.length) return "(no X posts found)";
      return (
        "FxTwitter live search was unavailable; these posts were discovered through " +
        "a free keyless web-search fallback and fetched from FxTwitter by validated " +
        "public post ID.\n\n" +
        posts.map((post, index) => `${index + 1}. ${post}`).join("\n\n")
      );
    } catch (error) {
      return `ERROR: X/Twitter search fallback failed: ${error.name || "Error"}: ${
        error.message || error
      }`;
    }
  }

  async fetchPost(value) {
    const id = postId(value);
    if (!id) {
      return "ERROR: post must be a numeric ID or a supported public X/Twitter post URL.";
    }
    const result = await this.request(`/2/status/${id}`);
    if (result.error) return result.error;
    if (!result.data.status) return "ERROR: FxTwitter returned no post.";
    return formatPost(result.data.status);
  }
}

// Downloads X posts that a message links to, without waiting for the model to decide
// to call a tool. Failures are reported inside the block so the model can say the post
// was unavailable instead of inventing its contents.
export class XPostPrefetcher {
  constructor({ client, maxPosts = 2, maxChars = 1_200 } = {}) {
    this.client = client;
    this.maxPosts = Math.max(1, Math.min(Number(maxPosts) || 1, 5));
    this.maxChars = Math.max(200, Math.min(Number(maxChars) || 1_200, 10_000));
  }

  async describe(content) {
    if (!this.client) return null;
    const urls = extractXPostUrls(content, this.maxPosts);
    if (!urls.length) return null;
    const posts = await Promise.all(
      urls.map(async (url) => {
        let result;
        try {
          result = await this.client.fetchPost(url);
        } catch (error) {
          result = `ERROR: ${error?.name || "Error"}: ${error?.message || error}`;
        }
        if (typeof result !== "string" || result.startsWith("ERROR:")) {
          const detail = oneLine(String(result || "").replace(/^ERROR:\s*/, ""), 200);
          return `${url}\n(not downloaded: ${detail || "unknown failure"})`;
        }
        return result;
      }),
    );
    const block = posts.join("\n\n");
    return block.length > this.maxChars
      ? `${block.slice(0, this.maxChars)}\n… (X post text truncated)`
      : block;
  }
}
