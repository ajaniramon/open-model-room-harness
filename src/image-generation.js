import { boundedFetch, readBoundedBuffer } from "./http.js";
import { isRetryableRequestError, retry } from "./retry.js";

const DEFAULT_ALIASES = Object.freeze({
  banana: "nano-banana-2-lite",
  "banana-lite": "nano-banana-2-lite",
  nanobanana: "nano-banana-2-lite",
  "nano banana": "nano-banana-2-lite",
  "nano banana lite": "nano-banana-2-lite",
  "nano banana 2 lite": "nano-banana-2-lite",
  "nano-banana-2-lite": "nano-banana-2-lite",
  "nano banana 2": "nano-banana-2",
  "nano-banana-2": "nano-banana-2",
});

function extensionForMime(mime) {
  if (/jpe?g/i.test(mime)) return "jpg";
  if (/webp/i.test(mime)) return "webp";
  if (/gif/i.test(mime)) return "gif";
  return "png";
}

function decodeBase64Image(value, maxBytes) {
  let encoded = String(value || "");
  let mime = "image/png";
  const dataUrl = encoded.match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/is);
  if (dataUrl) {
    mime = dataUrl[1];
    encoded = dataUrl[2];
  }
  const estimatedBytes = Math.ceil((encoded.length * 3) / 4);
  if (estimatedBytes > maxBytes) {
    throw new Error(`Generated image exceeds the ${maxBytes}-byte upload limit.`);
  }
  const buffer = Buffer.from(encoded, "base64");
  if (!buffer.length) throw new Error("NanoGPT returned an empty base64 image.");
  return { buffer, extension: extensionForMime(mime) };
}

export function isSafeHostedImageUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:") return false;
    const host = url.hostname.toLowerCase();
    // Reject IP-literal hosts outright: the IPv4 checks below never covered IPv6
    // literals ([::1], [::ffff:127.0.0.1]), which otherwise pass to the loopback.
    if (host.startsWith("[")) return false;
    if (host === "localhost" || host.endsWith(".local")) return false;
    if (/^(?:127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(host)) return false;
    const match = host.match(/^172\.(\d+)\./);
    if (match && Number(match[1]) >= 16 && Number(match[1]) <= 31) return false;
    return true;
  } catch {
    return false;
  }
}

export class NanoGptImageClient {
  constructor(config, fetchImplementation = fetch) {
    this.apiKey = config.nanoGptApiKey;
    this.baseUrl = config.imageApiBaseUrl.replace(/\/+$/, "");
    this.defaultModel = config.imageDefaultModel;
    this.timeoutMs = config.imageTimeoutMs;
    this.maxPromptChars = config.imageMaxPromptChars;
    this.maxBytes = config.imageMaxBytes;
    this.aliases = { ...DEFAULT_ALIASES, ...(config.imageModelAliases || {}) };
    this.fetch = fetchImplementation;
    this.modelCache = null;
    this.modelCacheExpiresAt = 0;
  }

  async listModels() {
    if (this.modelCache && Date.now() < this.modelCacheExpiresAt) return this.modelCache;
    // Bounded: this is reached with a user-supplied model name before the
    // generation timeout exists, so an unresponsive host must not hang the turn.
    const payload = await boundedFetch(`${this.baseUrl}/images/models`, {
      fetchImpl: this.fetch,
      timeoutMs: this.timeoutMs,
      parse: "json",
      label: "NanoGPT image catalog",
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });
    const models = Array.isArray(payload?.data) ? payload.data : [];
    this.modelCache = models;
    this.modelCacheExpiresAt = Date.now() + 10 * 60_000;
    return models;
  }

  async resolveModel(requestedModel) {
    const requested = String(requestedModel || "").trim().toLowerCase();
    if (!requested) return this.defaultModel;
    if (this.aliases[requested]) return this.aliases[requested];
    const models = await this.listModels();
    const match = models.find(
      (model) =>
        String(model?.id || "").toLowerCase() === requested &&
        model?.capabilities?.image_generation !== false,
    );
    if (!match) {
      throw new Error(
        `Image model '${requestedModel}' is not present in NanoGPT's live image catalog.`,
      );
    }
    return match.id;
  }

  async generate({ prompt, requestedModel = null }) {
    const cleanPrompt = String(prompt || "").trim();
    if (!cleanPrompt) throw new Error("Image generation requires a non-empty prompt.");
    if (cleanPrompt.length > this.maxPromptChars) {
      throw new Error(
        `Image prompt exceeds the ${this.maxPromptChars}-character limit.`,
      );
    }
    const model = await this.resolveModel(requestedModel);
    // Retries stay limited to throttling/5xx/network failures so a retry never
    // pays twice for a generation that already succeeded.
    return retry(
      async () => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
          const response = await this.fetch(`${this.baseUrl}/images/generations`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${this.apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model,
              prompt: cleanPrompt,
              n: 1,
              response_format: "b64_json",
            }),
            signal: controller.signal,
          });
          if (!response.ok) {
            const details = (await response.text()).slice(0, 500);
            const error = new Error(
              `NanoGPT image generation returned HTTP ${response.status}: ${details}`,
            );
            error.status = response.status;
            throw error;
          }
          const payload = await response.json();
          const entries = Array.isArray(payload?.data)
            ? payload.data
            : Array.isArray(payload?.images)
              ? payload.images
              : [];
          if (!entries.length) throw new Error("NanoGPT returned no generated images.");

          const images = [];
          for (const entry of entries.slice(0, 4)) {
            const b64 = typeof entry === "string" && !/^https:\/\//i.test(entry)
              ? entry
              : entry?.b64_json || entry?.base64 || null;
            if (b64) {
              images.push(decodeBase64Image(b64, this.maxBytes));
              continue;
            }
            const url = typeof entry === "string" ? entry : entry?.url;
            if (!isSafeHostedImageUrl(url)) {
              throw new Error("NanoGPT returned an unsafe or unsupported image URL.");
            }
            // redirect: "error" so a host that passed the allow-list cannot 302 to
            // internal metadata, and a streaming read so the size cap is enforced
            // before the whole body is buffered.
            const hosted = await this.fetch(url, {
              signal: controller.signal,
              redirect: "error",
            });
            if (!hosted.ok) {
              throw new Error(`Hosted image download returned HTTP ${hosted.status}.`);
            }
            const buffer = await readBoundedBuffer(hosted, this.maxBytes, "Hosted generated image");
            if (!buffer.length) {
              throw new Error("Hosted generated image is empty or exceeds the upload limit.");
            }
            images.push({
              buffer,
              extension: extensionForMime(hosted.headers.get("content-type") || "image/png"),
            });
          }
          return { model, prompt: cleanPrompt, images };
        } finally {
          clearTimeout(timeout);
        }
      },
      {
        attempts: 2,
        backoffMs: 700,
        shouldRetry: isRetryableRequestError,
        label: "NanoGPT image generation",
      },
    );
  }
}
