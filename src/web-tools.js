import { boundedFetch } from "./http.js";
import { X_FETCH_TOOL, X_SEARCH_TOOL } from "./x-tools.js";

export const WEB_SEARCH_TOOL = Object.freeze({
  type: "function",
  function: {
    name: "web_search",
    description:
      "Search the web and get ranked results (title, URL, snippet) plus a short synthesized answer when available. Use this when a participant explicitly asks you to search, look up, verify, or investigate something online, and for current events, recent facts, prices, or documentation. Do not guess when a search was requested.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query." },
        max_results: {
          type: "integer",
          description: "How many results to return (1-10, default 5).",
        },
      },
      required: ["query"],
    },
  },
});

export const WEB_FETCH_TOOL = Object.freeze({
  type: "function",
  function: {
    name: "web_fetch",
    description:
      "Fetch a URL and return its main page text (cleaned). Use to read a full page, such as a result returned by web_search or a known link. Returns up to max_chars characters.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "The URL to fetch." },
        max_chars: {
          type: "integer",
          description: "Maximum characters of content to return (default 8000).",
        },
      },
      required: ["url"],
    },
  },
});

export class TavilyClient {
  constructor(apiKey, fetchImplementation = fetch) {
    this.apiKey = apiKey;
    this.fetch = fetchImplementation;
  }

  async search(query, maxResults = 5) {
    if (!this.apiKey) {
      return "ERROR: web search is not configured — set TAVILY_API_KEY (get a free key at https://tavily.com).";
    }
    if (typeof query !== "string" || !query.trim()) {
      return "ERROR: query must be a non-empty string.";
    }

    let count = Number.parseInt(maxResults || 5, 10);
    if (!Number.isFinite(count)) count = 5;
    count = Math.max(1, Math.min(count, 10));

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25_000);
    try {
      const response = await this.fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: this.apiKey,
          query,
          max_results: count,
          search_depth: "advanced",
          include_answer: true,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const details = (await response.text()).slice(0, 200);
        return `ERROR: Tavily returned ${response.status}: ${details}`;
      }

      const data = await response.json();
      const output = [];
      const answer = String(data.answer || "").trim();
      if (answer) output.push(`Answer: ${answer}\n`);

      for (const [index, result] of (data.results || []).entries()) {
        const title = String(result.title || "").trim();
        const url = String(result.url || "");
        let snippet = String(result.content || "").split(/\s+/).filter(Boolean).join(" ");
        if (snippet.length > 500) snippet = `${snippet.slice(0, 500)}…`;
        output.push(`${index + 1}. ${title}\n   ${url}\n   ${snippet}`);
      }
      return output.join("\n") || "(no results)";
    } catch (error) {
      return `ERROR: web search failed: ${error.name || "Error"}: ${error.message || error}`;
    } finally {
      clearTimeout(timeout);
    }
  }

  async fetchUrl(url, maxChars = 8_000) {
    if (!this.apiKey) {
      return "ERROR: web fetch is not configured — set TAVILY_API_KEY (get a free key at https://tavily.com).";
    }
    if (typeof url !== "string" || !url.trim()) {
      return "ERROR: url must be a non-empty string.";
    }

    let limit = Number.parseInt(maxChars || 8_000, 10);
    if (!Number.isFinite(limit)) limit = 8_000;
    limit = Math.max(500, Math.min(limit, 20_000));

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await this.fetch("https://api.tavily.com/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: this.apiKey,
          urls: [url],
          extract_depth: "advanced",
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const details = (await response.text()).slice(0, 200);
        return `ERROR: Tavily returned ${response.status}: ${details}`;
      }

      const data = await response.json();
      const results = data.results || [];
      if (!results.length) {
        const failed = data.failed_results || [];
        const reason = failed.length ? ` (${failed[0].error || ""})` : "";
        return `ERROR: could not extract content from ${url}${reason}`;
      }
      let content = String(results[0].raw_content || "").trim();
      if (content.length > limit) {
        content = `${content.slice(0, limit)}\n… (truncated, ${content.length - limit} more chars)`;
      }
      return content || "(no content extracted)";
    } catch (error) {
      return `ERROR: web fetch failed: ${error.name || "Error"}: ${error.message || error}`;
    } finally {
      clearTimeout(timeout);
    }
  }
}

// Hosts the page prefetcher never downloads: X/Twitter posts belong to the X
// prefetcher, and GIF/media hosts carry no readable text worth an extract call.
const PREFETCH_SKIPPED_HOSTS = Object.freeze(
  new Set([
    "x.com",
    "www.x.com",
    "twitter.com",
    "www.twitter.com",
    "fxtwitter.com",
    "www.fxtwitter.com",
    "fixupx.com",
    "www.fixupx.com",
    "tenor.com",
    "media.tenor.com",
    "giphy.com",
    "media.giphy.com",
    "klipy.com",
    "www.klipy.com",
    "cdn.discordapp.com",
    "media.discordapp.net",
  ]),
);

// Only explicit http(s) links count: bare "example.com" mentions are prose, not a
// request to download anything. Candidates are split and trimmed like X links so
// <angle brackets> and glued punctuation do not break parsing.
export function extractWebPageUrls(content, maxUrls = 2) {
  const limit = Math.max(1, Math.min(Number(maxUrls) || 1, 5));
  const urls = [];
  const seen = new Set();
  for (const token of String(content || "").split(/[\s<>"'`]+/)) {
    if (!token) continue;
    const candidate = token.replace(/^[([{]+/, "").replace(/[),.;:!?\]}]+$/, "");
    if (!/^https?:\/\//i.test(candidate)) continue;
    let url;
    try {
      url = new URL(candidate);
    } catch {
      continue;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") continue;
    if (PREFETCH_SKIPPED_HOSTS.has(url.hostname.toLowerCase())) continue;
    if (seen.has(url.href)) continue;
    seen.add(url.href);
    urls.push(url.href);
    if (urls.length >= limit) break;
  }
  return urls;
}

// GitHub renders commits, pull requests, and files as chrome-heavy HTML whose
// actual content sits far below navigation menus, so HTML extraction returns
// "Explore by Topic" instead of code. GitHub's plain-text endpoints carry the
// real change, so known GitHub page URLs are rewritten before download:
// commits become .patch (commit message + diff), pull requests become .diff,
// and blob file views become their raw.githubusercontent.com counterpart.
export function normalizePrefetchUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase();
    if (host === "github.com" || host === "www.github.com") {
      const path = url.pathname;
      if (/^\/[^/]+\/[^/]+\/commit\/[0-9a-f]{7,40}$/i.test(path)) {
        return { url: `https://github.com${path}.patch`, plainText: true };
      }
      if (/^\/[^/]+\/[^/]+\/pull\/\d+$/.test(path)) {
        return { url: `https://github.com${path}.diff`, plainText: true };
      }
      if (/\.(?:diff|patch)$/i.test(path)) {
        return { url: url.href, plainText: true };
      }
      const blob = path.match(/^\/([^/]+)\/([^/]+)\/blob\/(.+)$/);
      if (blob) {
        return {
          url: `https://raw.githubusercontent.com/${blob[1]}/${blob[2]}/${blob[3]}`,
          plainText: true,
        };
      }
    }
    if (host === "raw.githubusercontent.com" || host === "gist.githubusercontent.com") {
      return { url: url.href, plainText: true };
    }
    return { url: url.href, plainText: false };
  } catch {
    return { url: String(rawUrl || ""), plainText: false };
  }
}

// Downloads ordinary web pages that an authorized message links to, without
// waiting for the model to decide to call a tool. HTML pages are extracted
// through the same Tavily route as web_fetch, so the harness never connects to
// arbitrary linked hosts directly; only GitHub's plain-text endpoints are
// fetched directly, because they need no extraction. Failures are reported
// inside the block so the model can say the page was unavailable instead of
// inventing its contents.
export class WebPagePrefetcher {
  constructor({ client, maxUrls = 2, maxChars = 3_000, fetchImplementation = fetch } = {}) {
    this.client = client;
    this.maxUrls = Math.max(1, Math.min(Number(maxUrls) || 1, 5));
    this.maxChars = Math.max(500, Math.min(Number(maxChars) || 3_000, 20_000));
    this.fetch = fetchImplementation;
  }

  async fetchPlainText(url, maxChars) {
    // Cap the download by bytes so a link to a 100 MB raw file (e.g. a GitHub
    // blob) is stream-cancelled instead of buffered whole to keep ~maxChars.
    const maxBytes = Math.max(64_000, maxChars * 8);
    let text;
    try {
      text = await boundedFetch(url, {
        fetchImpl: this.fetch,
        timeoutMs: 20_000,
        parse: "text",
        maxBytes,
        label: new URL(url).hostname,
        headers: { Accept: "text/plain" },
      });
    } catch (error) {
      return `ERROR: ${error?.message || error?.name || error}`;
    }
    if (!text.trim()) return "ERROR: the plain-text endpoint returned no content.";
    if (text.length > maxChars) {
      return `${text.slice(0, maxChars)}\n… (truncated, ${text.length - maxChars} more chars)`;
    }
    return text;
  }

  async describe(content) {
    if (!this.client) return null;
    const urls = extractWebPageUrls(content, this.maxUrls);
    if (!urls.length) return null;
    const perUrlChars = Math.max(500, Math.floor(this.maxChars / urls.length));
    const pages = await Promise.all(
      urls.map(async (url) => {
        const target = normalizePrefetchUrl(url);
        let result;
        try {
          result = target.plainText
            ? await this.fetchPlainText(target.url, perUrlChars)
            : await this.client.fetchUrl(target.url, perUrlChars);
        } catch (error) {
          result = `ERROR: ${error?.name || "Error"}: ${error?.message || error}`;
        }
        if (
          typeof result !== "string" ||
          result.startsWith("ERROR:") ||
          !result.trim() ||
          result === "(no content extracted)"
        ) {
          const detail = String(result || "")
            .replace(/^ERROR:\s*/, "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 200);
          return `${url}\n(not downloaded: ${detail || "unknown failure"})`;
        }
        return `${url}\n${result}`;
      }),
    );
    const block = pages.join("\n\n");
    return block.length > this.maxChars
      ? `${block.slice(0, this.maxChars)}\n… (page text truncated)`
      : block;
  }
}

export class WebToolRuntime {
  constructor(tavilyClient, fxTwitterClient = null) {
    this.tavily = tavilyClient;
    this.fxTwitter = fxTwitterClient;
    this.tools = [WEB_SEARCH_TOOL, WEB_FETCH_TOOL, X_SEARCH_TOOL, X_FETCH_TOOL];
  }

  async call(name, rawArguments) {
    if (!new Set(this.tools.map((tool) => tool.function.name)).has(name)) {
      return `ERROR: unknown tool ${name}`;
    }
    let args;
    try {
      args = typeof rawArguments === "string" ? JSON.parse(rawArguments) : rawArguments;
    } catch (error) {
      return `ERROR: invalid JSON in arguments for '${name}' (${error.message}). Re-issue the call with valid JSON.`;
    }
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      return `ERROR: arguments for '${name}' must be a JSON object.`;
    }
    if (name === "web_search") return this.tavily.search(args.query, args.max_results);
    if (name === "web_fetch") return this.tavily.fetchUrl(args.url, args.max_chars);
    if (!this.fxTwitter) return "ERROR: X/Twitter tools are not configured.";
    if (name === "x_search") {
      return this.fxTwitter.search(args.query, args.max_results, args.feed);
    }
    return this.fxTwitter.fetchPost(args.post);
  }
}
