const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const SUPPORTED_PROVIDERS = new Set([
  "none",
  "nanogpt",
  "openai",
  "anthropic",
  "xai",
  "gemini",
  "local",
]);

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function providerLabel(provider) {
  return {
    none: "No model provider",
    nanogpt: "NanoGPT",
    openai: "OpenAI",
    anthropic: "Anthropic",
    xai: "xAI",
    gemini: "Gemini",
    local: "Local OpenAI-compatible server",
  }[provider] || provider;
}

function visibleText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

function legacyProviderConfig(config) {
  return {
    apiKey: config.nanoGptApiKey,
    model: config.nanoGptModel,
    baseUrl: config.nanoGptBaseUrl,
  };
}

function supportsOpenAiReasoning(model) {
  return /^(?:gpt-5|o\d)/i.test(String(model || ""));
}

function anthropicMessages(messages) {
  const system = messages
    .filter((message) => message.role === "system")
    .map((message) => visibleText(message.content))
    .filter(Boolean)
    .join("\n\n");
  const converted = [];

  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "tool") {
      const block = {
        type: "tool_result",
        tool_use_id: message.tool_call_id,
        content: String(message.content || ""),
      };
      const previous = converted.at(-1);
      if (
        previous?.role === "user" &&
        previous.content.every((part) => part.type === "tool_result")
      ) {
        previous.content.push(block);
      } else {
        converted.push({ role: "user", content: [block] });
      }
      continue;
    }

    const content = [];
    const text = visibleText(message.content);
    if (text) content.push({ type: "text", text });
    if (message.role === "assistant") {
      for (const toolCall of message.tool_calls || []) {
        let input = {};
        try {
          input = JSON.parse(toolCall?.function?.arguments || "{}");
        } catch {
          input = {};
        }
        content.push({
          type: "tool_use",
          id: toolCall.id,
          name: toolCall?.function?.name || "",
          input,
        });
      }
    }
    converted.push({
      role: message.role === "assistant" ? "assistant" : "user",
      content: content.length ? content : [{ type: "text", text: "" }],
    });
  }

  return { system, messages: converted };
}

function geminiMessages(messages) {
  const system = messages
    .filter((message) => message.role === "system")
    .map((message) => visibleText(message.content))
    .filter(Boolean)
    .join("\n\n");
  const contents = [];

  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "tool") {
      const part = {
        functionResponse: {
          id: message.tool_call_id,
          name: message.name || "tool",
          response: { result: String(message.content || "") },
        },
      };
      const previous = contents.at(-1);
      if (
        previous?.role === "user" &&
        previous.parts.every((item) => item.functionResponse)
      ) {
        previous.parts.push(part);
      } else {
        contents.push({ role: "user", parts: [part] });
      }
      continue;
    }

    const parts = [];
    const text = visibleText(message.content);
    if (text) parts.push({ text });
    if (message.role === "assistant") {
      for (const toolCall of message.tool_calls || []) {
        if (toolCall._geminiPart) {
          parts.push(toolCall._geminiPart);
          continue;
        }
        let args = {};
        try {
          args = JSON.parse(toolCall?.function?.arguments || "{}");
        } catch {
          args = {};
        }
        parts.push({
          functionCall: {
            id: toolCall.id,
            name: toolCall?.function?.name || "",
            args,
          },
        });
      }
    }
    contents.push({
      role: message.role === "assistant" ? "model" : "user",
      parts: parts.length ? parts : [{ text: "" }],
    });
  }

  return { system, contents };
}

export class ModelClient {
  constructor(config, fetchImplementation = fetch, toolRuntime = null) {
    this.config = config;
    this.fetch = fetchImplementation;
    this.toolRuntime = toolRuntime;
  }

  route(options = {}) {
    const provider = String(
      options.provider || this.config.chatProvider || "nanogpt",
    ).toLowerCase();
    if (!SUPPORTED_PROVIDERS.has(provider)) {
      throw new Error(`Unsupported model provider '${provider}'`);
    }
    const defaults =
      this.config.modelProviders?.[provider] ||
      (provider === "nanogpt" ? legacyProviderConfig(this.config) : {});
    if (provider === "none") {
      return {
        provider,
        apiKey: "",
        model: options.model || defaults.model || "none",
        baseUrl: "",
        reasoningEffort: "none",
        maxOutputTokens: options.maxOutputTokens ?? this.config.maxOutputTokens,
      };
    }
    const route = {
      provider,
      apiKey: options.apiKey || defaults.apiKey || "",
      model: options.model || defaults.model || "",
      baseUrl: options.baseUrl || defaults.baseUrl || "",
      reasoningEffort: options.reasoningEffort ?? this.config.reasoningEffort,
      maxOutputTokens: options.maxOutputTokens ?? this.config.maxOutputTokens,
    };
    if (!route.apiKey && provider !== "local") {
      throw new Error(`${providerLabel(provider)} API key is not configured`);
    }
    if (!route.model) {
      throw new Error(`${providerLabel(provider)} model is not configured`);
    }
    if (!route.baseUrl) {
      throw new Error(`${providerLabel(provider)} API endpoint is not configured`);
    }
    return route;
  }

  async complete(messages, { enabledToolNames = [], ...options } = {}) {
    const route = this.route(options);
    if (route.provider === "none") {
      return (
        "[model disabled] Discord connectivity is running without an inference provider. " +
        "Runtime controls, behavior modes, participation policy, and MCP plumbing can be tested."
      );
    }
    const conversation = messages.map((message) => ({ ...message }));
    const maxIterations = this.config.maxToolIterations || 4;
    let emptyResponseRetries = 0;
    let toolIterations = 0;
    const enabledNames = new Set(enabledToolNames);
    const activeTools = (this.toolRuntime?.tools || []).filter((tool) =>
      enabledNames.has(tool?.function?.name),
    );
    const activeToolRuntime = activeTools.length
      ? {
          tools: activeTools,
          call: async (name, args) => {
            if (!enabledNames.has(name)) {
              return `ERROR: tool '${name}' is not authorized for this turn`;
            }
            return this.toolRuntime.call(name, args);
          },
        }
      : null;

    while (true) {
      const { message, finishReason } = await this.request(
        conversation,
        activeToolRuntime,
        route,
      );
      const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      if (!toolCalls.length) {
        const content = typeof message.content === "string" ? message.content.trim() : "";
        if (!content && emptyResponseRetries < 1) {
          emptyResponseRetries += 1;
          continue;
        }
        if (!content) {
          throw new Error(
            `${providerLabel(route.provider)} returned no visible response content after retry ` +
              `(finish_reason=${finishReason || "unknown"})`,
          );
        }
        return content;
      }
      if (!activeToolRuntime) {
        throw new Error(
          `${providerLabel(route.provider)} requested a tool but no tool runtime is configured`,
        );
      }
      if (toolIterations >= maxIterations) {
        throw new Error(`${providerLabel(route.provider)} exceeded ${maxIterations} tool iterations`);
      }

      conversation.push({
        role: "assistant",
        content: message.content || null,
        tool_calls: toolCalls,
      });
      for (const [index, toolCall] of toolCalls.entries()) {
        const name = toolCall?.function?.name || "";
        const args = toolCall?.function?.arguments || "{}";
        const result = await activeToolRuntime.call(name, args);
        conversation.push({
          role: "tool",
          tool_call_id: toolCall.id || `tool_${toolIterations}_${index}`,
          name,
          content: result,
        });
      }
      toolIterations += 1;
    }
  }

  async request(messages, activeToolRuntime, route) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.config.apiTimeoutMs);
      try {
        const response = await this.providerRequest(
          messages,
          activeToolRuntime,
          route,
          controller.signal,
        );
        if (!response.ok) {
          const details = (await response.text()).slice(0, 500);
          if (attempt === 0 && RETRYABLE_STATUS.has(response.status)) {
            await sleep(700);
            continue;
          }
          throw new Error(
            `${providerLabel(route.provider)} returned HTTP ${response.status}: ${details}`,
          );
        }
        const payload = await response.json();
        return this.normalizeResponse(payload, route.provider);
      } catch (error) {
        if (attempt === 0 && (error.name === "AbortError" || error instanceof TypeError)) {
          await sleep(700);
          continue;
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    }
    throw new Error(`${providerLabel(route.provider)} request failed after retry`);
  }

  providerRequest(messages, activeToolRuntime, route, signal) {
    if (route.provider === "anthropic") {
      const converted = anthropicMessages(messages);
      const body = {
        model: route.model,
        max_tokens: route.maxOutputTokens,
        messages: converted.messages,
      };
      if (converted.system) body.system = converted.system;
      if (activeToolRuntime?.tools?.length) {
        body.tools = activeToolRuntime.tools.map((tool) => ({
          name: tool.function.name,
          description: tool.function.description || "",
          input_schema: tool.function.parameters || { type: "object", properties: {} },
        }));
      }
      return this.fetch(route.baseUrl, {
        method: "POST",
        headers: {
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
          "x-api-key": route.apiKey,
        },
        body: JSON.stringify(body),
        signal,
      });
    }

    if (route.provider === "gemini") {
      const converted = geminiMessages(messages);
      const endpoint =
        `${route.baseUrl.replace(/\/+$/, "")}/models/${encodeURIComponent(route.model)}:generateContent`;
      const body = {
        contents: converted.contents,
        generationConfig: { maxOutputTokens: route.maxOutputTokens },
      };
      if (converted.system) body.systemInstruction = { parts: [{ text: converted.system }] };
      if (activeToolRuntime?.tools?.length) {
        body.tools = [
          {
            functionDeclarations: activeToolRuntime.tools.map((tool) => ({
              name: tool.function.name,
              description: tool.function.description || "",
              parameters: tool.function.parameters || { type: "object", properties: {} },
            })),
          },
        ];
      }
      return this.fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": route.apiKey,
        },
        body: JSON.stringify(body),
        signal,
      });
    }

    const body = {
      model: route.model,
      messages,
      stream: false,
    };
    if (route.provider === "openai") {
      body.max_completion_tokens = route.maxOutputTokens;
      if (supportsOpenAiReasoning(route.model)) {
        body.reasoning_effort = activeToolRuntime?.tools?.length
          ? "none"
          : route.reasoningEffort;
      }
    } else if (route.provider === "local") {
      // llama.cpp and vLLM both accept the core OpenAI Chat Completions
      // contract. Avoid vendor-only reasoning fields that strict local
      // servers may reject.
      body.max_tokens = route.maxOutputTokens;
    } else {
      body.max_tokens = route.maxOutputTokens;
      body.reasoning_effort = route.reasoningEffort;
    }
    if (route.provider === "nanogpt") body.reasoning = { exclude: true };
    if (activeToolRuntime?.tools?.length) {
      body.tools = activeToolRuntime.tools;
      body.tool_choice = "auto";
    }
    const headers = { "Content-Type": "application/json" };
    if (route.apiKey) headers.Authorization = `Bearer ${route.apiKey}`;
    return this.fetch(route.baseUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });
  }

  normalizeResponse(payload, provider) {
    if (provider === "anthropic") {
      const blocks = Array.isArray(payload?.content) ? payload.content : [];
      const text = blocks
        .filter((block) => block?.type === "text")
        .map((block) => block.text || "")
        .join("\n");
      const toolCalls = blocks
        .filter((block) => block?.type === "tool_use")
        .map((block) => ({
          id: block.id,
          type: "function",
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input || {}),
          },
        }));
      if (!blocks.length) throw new Error("Anthropic returned no content blocks");
      return {
        message: { role: "assistant", content: text || null, tool_calls: toolCalls },
        finishReason: payload.stop_reason || null,
      };
    }

    if (provider === "gemini") {
      const candidate = payload?.candidates?.[0];
      const parts = candidate?.content?.parts;
      if (!Array.isArray(parts)) throw new Error("Gemini returned no candidate content");
      const text = parts
        .filter((part) => typeof part?.text === "string")
        .map((part) => part.text)
        .join("\n");
      const toolCalls = parts
        .filter((part) => part?.functionCall)
        .map((part, index) => ({
          id: part.functionCall.id || `gemini_call_${index}`,
          type: "function",
          function: {
            name: part.functionCall.name,
            arguments: JSON.stringify(part.functionCall.args || {}),
          },
          _geminiPart: part,
        }));
      return {
        message: { role: "assistant", content: text || null, tool_calls: toolCalls },
        finishReason: candidate.finishReason || null,
      };
    }

    const choice = payload?.choices?.[0];
    if (!choice?.message) {
      throw new Error(`${providerLabel(provider)} returned no assistant message`);
    }
    return { message: choice.message, finishReason: choice.finish_reason || null };
  }
}

export { SUPPORTED_PROVIDERS };
