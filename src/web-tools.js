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

export class WebToolRuntime {
  constructor(tavilyClient) {
    this.tavily = tavilyClient;
    this.tools = [WEB_SEARCH_TOOL, WEB_FETCH_TOOL];
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
    return this.tavily.fetchUrl(args.url, args.max_chars);
  }
}
