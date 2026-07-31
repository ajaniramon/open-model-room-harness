const DEFAULT_LOCAL_BASE_URL = "http://127.0.0.1:8080/v1";

export function normalizeOpenAiCompatibleBaseUrl(
  value,
  fallback = DEFAULT_LOCAL_BASE_URL,
) {
  const raw = String(value || "").trim() || fallback;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Local API URL must be a valid http:// or https:// URL.");
  }
  if (!new Set(["http:", "https:"]).has(url.protocol)) {
    throw new Error("Local API URL must use http:// or https://.");
  }
  if (url.username || url.password) {
    throw new Error("Put local API credentials in the API key field, not in the URL.");
  }
  url.search = "";
  url.hash = "";
  let path = url.pathname.replace(/\/+$/, "");
  path = path.replace(/\/chat\/completions$/i, "");
  if (!path) path = "/v1";
  url.pathname = path;
  return url.toString().replace(/\/+$/, "");
}

export function openAiCompatibleChatUrl(value) {
  return `${normalizeOpenAiCompatibleBaseUrl(value)}/chat/completions`;
}

export function openAiCompatibleModelsUrl(value) {
  return `${normalizeOpenAiCompatibleBaseUrl(value)}/models`;
}

export { DEFAULT_LOCAL_BASE_URL };
