import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isRetryableRequestError, retry } from "./retry.js";

export function prepareSpeechText(text, maxChars = 1_200) {
  const speech = String(text || "").trim();
  if (speech.length <= maxChars) return speech;
  const candidate = speech.slice(0, Math.max(1, maxChars - 1));
  const boundary = Math.max(
    candidate.lastIndexOf(". "),
    candidate.lastIndexOf("! "),
    candidate.lastIndexOf("? "),
    candidate.lastIndexOf(" "),
  );
  const end = boundary > maxChars * 0.6 ? boundary + 1 : candidate.length;
  return `${candidate.slice(0, end).trimEnd()}…`;
}

export class AudioModeState {
  constructor(path, defaultEnabled = false) {
    this.path = path;
    this.enabled = defaultEnabled;
  }

  async load() {
    try {
      const payload = JSON.parse(await readFile(this.path, "utf8"));
      this.enabled = payload.enabled === true;
    } catch (error) {
      if (error.code !== "ENOENT") {
        console.warn(`Could not load audio mode state: ${error.message || error}`);
      }
    }
    return this.enabled;
  }

  async set(enabled) {
    this.enabled = enabled === true;
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(
      this.path,
      `${JSON.stringify({ enabled: this.enabled }, null, 2)}\n`,
      "utf8",
    );
    return this.enabled;
  }
}

export class ElevenLabsTtsClient {
  constructor(config, fetchImplementation = fetch) {
    this.apiKey = config.elevenLabsApiKey;
    this.voiceId = config.elevenLabsVoiceId;
    this.modelId = config.elevenLabsModelId;
    this.outputFormat = config.elevenLabsOutputFormat;
    this.timeoutMs = config.elevenLabsTimeoutMs;
    this.maxChars = config.audioMaxChars;
    this.maxBytes = config.audioMaxBytes;
    this.fetch = fetchImplementation;
  }

  get configured() {
    return Boolean(this.apiKey && this.voiceId);
  }

  async synthesize(text) {
    if (!this.configured) {
      throw new Error("ElevenLabs is not configured; set ELEVENLABS_API_KEY.");
    }
    const speech = prepareSpeechText(text, this.maxChars);
    if (!speech) throw new Error("Cannot synthesize an empty response.");

    return retry(
      async () => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
          const url =
            `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(this.voiceId)}` +
            `?output_format=${encodeURIComponent(this.outputFormat)}`;
          const response = await this.fetch(url, {
            method: "POST",
            headers: {
              Accept: "audio/mpeg",
              "Content-Type": "application/json",
              "xi-api-key": this.apiKey,
            },
            body: JSON.stringify({
              text: speech,
              model_id: this.modelId,
            }),
            signal: controller.signal,
          });
          if (!response.ok) {
            const details = (await response.text()).slice(0, 500);
            const error = new Error(`ElevenLabs returned HTTP ${response.status}: ${details}`);
            error.status = response.status;
            throw error;
          }
          const audio = Buffer.from(await response.arrayBuffer());
          if (!audio.length) throw new Error("ElevenLabs returned an empty audio file.");
          if (audio.length > this.maxBytes) {
            throw new Error(`Generated audio exceeds the ${this.maxBytes}-byte upload limit.`);
          }
          return audio;
        } finally {
          clearTimeout(timeout);
        }
      },
      {
        attempts: 2,
        backoffMs: 700,
        shouldRetry: isRetryableRequestError,
        label: "ElevenLabs synthesis",
      },
    );
  }
}
