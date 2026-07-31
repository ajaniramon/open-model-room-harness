import { openAiCompatibleModelsUrl } from "../src/openai-compatible.js";

const TIMEOUT_MS = 15_000;
const MAX_RESPONSE_CHARS = 2_000_000;
const MAX_MODELS = 2_000;

function clean(value, maximum = 20_000) {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

function isOpenAiChatModel(id) {
  if (!/^(gpt-|o\d|chatgpt-)/i.test(id)) return false;
  return !/(audio|realtime|transcri|tts|image|embedding|moderation|search|computer-use)/i.test(id);
}

function isXaiChatModel(id) {
  return /grok/i.test(id) && !/(image|imagine|video|embedding)/i.test(id);
}

function normalizeModels(models) {
  return [...new Set(models.map((model) => clean(model, 300)).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
    .slice(0, MAX_MODELS);
}

function requestFor(provider, apiKey, baseUrl) {
  switch (provider) {
    case "nanogpt":
      return {
        url: "https://nano-gpt.com/api/subscription/v1/models?detailed=true",
        headers: { Authorization: `Bearer ${apiKey}` },
        parse: (body) => body.data?.map((model) => model.id) || [],
      };
    case "openai":
      return {
        url: "https://api.openai.com/v1/models",
        headers: { Authorization: `Bearer ${apiKey}` },
        parse: (body) =>
          (body.data || []).map((model) => model.id).filter(isOpenAiChatModel),
      };
    case "anthropic":
      return {
        url: "https://api.anthropic.com/v1/models?limit=1000",
        headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
        parse: (body) => body.data?.map((model) => model.id) || [],
      };
    case "xai":
      return {
        url: "https://api.x.ai/v1/models",
        headers: { Authorization: `Bearer ${apiKey}` },
        parse: (body) => (body.data || []).map((model) => model.id).filter(isXaiChatModel),
      };
    case "gemini":
      return {
        url: `https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&key=${encodeURIComponent(apiKey)}`,
        headers: {},
        parse: (body) =>
          (body.models || [])
            .filter((model) => model.supportedGenerationMethods?.includes("generateContent"))
            .map((model) => model.baseModelId || model.name?.replace(/^models\//, "")),
      };
    case "local":
      return {
        url: openAiCompatibleModelsUrl(baseUrl),
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        parse: (body) => (body.data || []).map((model) => model.id),
      };
    default:
      throw new Error("Choose a supported provider before loading models.");
  }
}

export async function listProviderModels(providerValue, apiKeyValue, options = {}) {
  const provider = clean(providerValue, 30).toLowerCase();
  const apiKey = clean(apiKeyValue);
  if (!apiKey && provider !== "local") {
    throw new Error("Paste the provider API key before loading models.");
  }
  const request = requestFor(provider, apiKey, options.baseUrl);
  const fetchImpl = options.fetchImpl || fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || TIMEOUT_MS);
  try {
    const response = await fetchImpl(request.url, {
      method: "GET",
      headers: { Accept: "application/json", ...request.headers },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(
        response.status === 401 || response.status === 403
          ? "The provider rejected that API key."
          : `The provider model catalog returned HTTP ${response.status}.`,
      );
    }
    const text = await response.text();
    if (text.length > MAX_RESPONSE_CHARS) throw new Error("The provider model catalog is too large.");
    const models = normalizeModels(request.parse(JSON.parse(text)));
    if (!models.length) throw new Error("No compatible conversation models were returned.");
    return models;
  } catch (error) {
    if (error.name === "AbortError") throw new Error("The provider model catalog timed out.");
    if (error instanceof SyntaxError) throw new Error("The provider returned an invalid model catalog.");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
