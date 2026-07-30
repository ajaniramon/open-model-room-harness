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

function postId(value) {
  if (typeof value !== "string") return "";
  const input = value.trim();
  if (/^\d{2,20}$/.test(input)) return input;
  try {
    const url = new URL(input);
    const allowedHosts = new Set([
      "x.com",
      "www.x.com",
      "twitter.com",
      "www.twitter.com",
      "fxtwitter.com",
      "www.fxtwitter.com",
      "fixupx.com",
      "www.fixupx.com",
    ]);
    if (!allowedHosts.has(url.hostname.toLowerCase())) return "";
    return url.pathname.match(/\/status\/(\d{2,20})(?:\/|$)/)?.[1] || "";
  } catch {
    return "";
  }
}

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
  constructor(fetchImplementation = fetch, baseUrl = "https://api.fxtwitter.com") {
    this.fetch = fetchImplementation;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  async request(path) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    try {
      const response = await this.fetch(`${this.baseUrl}${path}`, {
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data || data.code >= 400) {
        const detail = oneLine(data?.message || response.statusText || "request failed", 200);
        return { error: `ERROR: FxTwitter returned ${data?.code || response.status}: ${detail}` };
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
    if (result.error) return result.error;
    const posts = Array.isArray(result.data.results) ? result.data.results.slice(0, count) : [];
    return posts.map((post, index) => formatPost(post, index)).join("\n\n") || "(no X posts found)";
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
