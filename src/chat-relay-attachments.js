import { createHash } from "node:crypto";
import { downloadDiscordImageAttachment } from "./vision.js";

const SUPPORTED_IMAGE_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
]);

const SUPPORTED_TEXT_TYPES = new Set([
  "application/json",
  "application/x-ndjson",
  "application/xml",
  "application/yaml",
  "text/csv",
  "text/markdown",
  "text/plain",
  "text/tab-separated-values",
  "text/xml",
  "text/yaml",
]);

const SUPPORTED_TEXT_EXTENSIONS = /\.(?:c|conf|cpp|cs|css|csv|diff|env\.example|go|h|hpp|htm|html|ini|java|js|json|jsonl|jsx|log|lua|md|mjs|patch|php|ps1|py|rb|rs|sh|sql|toml|ts|tsx|txt|xml|yaml|yml)$/i;

const SUPPORTED_AUDIO_TYPES = new Set([
  "audio/mpeg",
  "audio/mp3",
  "audio/wav",
  "audio/wave",
  "audio/x-wav",
  "audio/ogg",
  "application/ogg",
]);

const GENERIC_BINARY_TYPES = new Set([
  "application/octet-stream",
  "binary/octet-stream",
]);

const SUPPORTED_AUDIO_EXTENSIONS = /\.(?:mp3|ogg|wav)$/i;

function normalizedType(value) {
  const type = String(value || "").split(";")[0].trim().toLowerCase();
  if (type === "audio/mp3" || type === "audio/mpeg3" || type === "audio/x-mpeg" || type === "audio/x-mp3") {
    return "audio/mpeg";
  }
  return type;
}

function supportedImageReference({ contentType, filename }) {
  return SUPPORTED_IMAGE_TYPES.has(normalizedType(contentType)) || /\.(?:gif|jpe?g|png|webp)$/i.test(String(filename || ""));
}

function supportedTextReference({ contentType, filename }) {
  return SUPPORTED_TEXT_TYPES.has(normalizedType(contentType)) || SUPPORTED_TEXT_EXTENSIONS.test(String(filename || ""));
}

function supportedAudioReference({ contentType, filename }) {
  return SUPPORTED_AUDIO_TYPES.has(normalizedType(contentType)) || SUPPORTED_AUDIO_EXTENSIONS.test(String(filename || ""));
}

function discordCdnUrl(value) {
  try {
    const url = new URL(String(value || ""));
    if (url.protocol !== "https:") return null;
    const hostname = url.hostname.toLowerCase();
    if (
      hostname !== "cdn.discordapp.com" &&
      hostname !== "media.discordapp.net" &&
      !/^images-ext-\d+\.discordapp\.net$/.test(hostname)
    ) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function discordImageUrl(value) {
  return discordCdnUrl(value);
}

function values(collection) {
  return [...(collection?.values?.() || [])];
}

function optionalNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function collectRelayImageAttachments(message, maxAttachments = 4) {
  const requestedLimit = Number(maxAttachments);
  const limit = Math.max(0, Math.min(Number.isFinite(requestedLimit) ? requestedLimit : 4, 10));
  const references = [];
  const seen = new Set();

  const add = ({ source, url, filename = null, contentType = null, size = null, width = null, height = null }) => {
    const safeUrl = discordImageUrl(url);
    if (!safeUrl || seen.has(safeUrl) || references.length >= limit) return;
    if (!supportedImageReference({ contentType, filename }) && !String(source).startsWith("embed-")) return;
    seen.add(safeUrl);
    references.push({
      source,
      url: safeUrl,
      filename: filename ? String(filename).slice(0, 200) : null,
      contentType: normalizedType(contentType) || null,
      size: optionalNumber(size),
      width: optionalNumber(width),
      height: optionalNumber(height),
    });
  };

  for (const attachment of values(message?.attachments)) {
    add({
      source: "attachment",
      url: attachment.url,
      filename: attachment.name,
      contentType: attachment.contentType,
      size: attachment.size,
      width: attachment.width,
      height: attachment.height,
    });
  }

  for (const embed of message?.embeds || []) {
    add({
      source: "embed-image",
      url: embed.image?.proxyURL || embed.image?.url,
      filename: "embed-image",
      contentType: "image/webp",
      width: embed.image?.width,
      height: embed.image?.height,
    });
    add({
      source: "embed-thumbnail",
      url: embed.thumbnail?.proxyURL || embed.thumbnail?.url,
      filename: "embed-thumbnail",
      contentType: "image/webp",
      width: embed.thumbnail?.width,
      height: embed.thumbnail?.height,
    });
  }

  for (const sticker of values(message?.stickers)) {
    add({
      source: "sticker",
      url: sticker.url,
      filename: sticker.name || "sticker",
      contentType: "image/png",
    });
  }

  return references;
}

function findMp3FrameOffset(bytes, start = 0, limit = 65_536) {
  const max = Math.min(bytes.length - 4, Math.max(0, start) + limit);
  for (let offset = Math.max(0, start); offset <= max; offset += 1) {
    if (bytes[offset] !== 0xff || (bytes[offset + 1] & 0xe0) !== 0xe0) continue;
    const versionBits = (bytes[offset + 1] >> 3) & 0x03;
    const layerBits = (bytes[offset + 1] >> 1) & 0x03;
    const bitrateIndex = (bytes[offset + 2] >> 4) & 0x0f;
    const sampleRateIndex = (bytes[offset + 2] >> 2) & 0x03;
    if (versionBits === 1 || layerBits === 0 || bitrateIndex === 0 || bitrateIndex === 15) continue;
    if (sampleRateIndex === 3) continue;
    return offset;
  }
  return -1;
}

function sniffAudio(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 4) return null;
  const head4 = bytes.subarray(0, 4).toString("ascii");
  if (head4 === "RIFF" && bytes.length >= 12 && bytes.subarray(8, 12).toString("ascii") === "WAVE") {
    return "audio/wav";
  }
  if (head4 === "OggS") return "audio/ogg";
  if (bytes.subarray(0, 3).toString("ascii") === "ID3") return "audio/mpeg";
  if (findMp3FrameOffset(bytes) >= 0) return "audio/mpeg";
  return null;
}

function riffChunk(bytes, name) {
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const chunkName = bytes.subarray(offset, offset + 4).toString("ascii");
    const size = bytes.readUInt32LE(offset + 4);
    const dataOffset = offset + 8;
    if (chunkName === name && dataOffset + size <= bytes.length) {
      return bytes.subarray(dataOffset, dataOffset + size);
    }
    offset = dataOffset + size + (size % 2);
  }
  return null;
}

function wavDurationSeconds(bytes) {
  if (bytes.length < 44 || bytes.subarray(0, 4).toString("ascii") !== "RIFF") return null;
  const fmt = riffChunk(bytes, "fmt ");
  const data = riffChunk(bytes, "data");
  if (!fmt || !data || fmt.length < 16) return null;
  const byteRate = fmt.readUInt32LE(8);
  if (!Number.isFinite(byteRate) || byteRate <= 0) return null;
  return Math.round((data.length / byteRate) * 1000) / 1000;
}

function id3v2Size(bytes) {
  if (bytes.length < 10 || bytes.subarray(0, 3).toString("ascii") !== "ID3") return 0;
  const size =
    ((bytes[6] & 0x7f) << 21) |
    ((bytes[7] & 0x7f) << 14) |
    ((bytes[8] & 0x7f) << 7) |
    (bytes[9] & 0x7f);
  return 10 + size;
}

const MP3_BITRATE_KBPS = {
  V1L1: [null, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  V1L2: [null, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  V1L3: [null, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  V2L1: [null, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  V2L2: [null, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};

function mp3DurationSeconds(bytes) {
  const start = id3v2Size(bytes);
  const frameOffset = findMp3FrameOffset(bytes, start, 65_536);
  if (frameOffset < 0) return null;
  for (let offset = frameOffset; offset + 4 <= bytes.length && offset < frameOffset + 4096; offset += 1) {
    if (bytes[offset] !== 0xff || (bytes[offset + 1] & 0xe0) !== 0xe0) continue;
    const versionBits = (bytes[offset + 1] >> 3) & 0x03;
    const layerBits = (bytes[offset + 1] >> 1) & 0x03;
    const bitrateIndex = (bytes[offset + 2] >> 4) & 0x0f;
    if (versionBits === 1 || layerBits === 0 || bitrateIndex === 0 || bitrateIndex === 15) continue;
    const mpeg1 = versionBits === 3;
    const layerName = layerBits === 3 ? "L1" : layerBits === 2 ? "L2" : "L3";
    const table = mpeg1
      ? MP3_BITRATE_KBPS[`V1${layerName}`]
      : (layerName === "L1" ? MP3_BITRATE_KBPS.V2L1 : MP3_BITRATE_KBPS.V2L2);
    const kbps = table?.[bitrateIndex];
    if (!kbps) continue;
    const audioBytes = Math.max(0, bytes.length - frameOffset);
    return Math.round((audioBytes * 8 / (kbps * 1000)) * 1000) / 1000;
  }
  return null;
}

function audioDurationSeconds(bytes, mimeType) {
  if (mimeType === "audio/wav") return wavDurationSeconds(bytes);
  if (mimeType === "audio/mpeg") return mp3DurationSeconds(bytes);
  return null;
}

export function collectRelayTextAttachments(message, maxAttachments = 4) {
  const requestedLimit = Number(maxAttachments);
  const limit = Math.max(0, Math.min(Number.isFinite(requestedLimit) ? requestedLimit : 4, 10));
  const references = [];
  const seen = new Set();

  for (const attachment of values(message?.attachments)) {
    const safeUrl = discordCdnUrl(attachment.url);
    if (!safeUrl || seen.has(safeUrl) || references.length >= limit) continue;
    if (!supportedTextReference({ contentType: attachment.contentType, filename: attachment.name })) continue;
    seen.add(safeUrl);
    references.push({
      source: "attachment",
      url: safeUrl,
      filename: attachment.name ? String(attachment.name).slice(0, 200) : null,
      contentType: normalizedType(attachment.contentType) || null,
      size: optionalNumber(attachment.size),
    });
  }

  return references;
}

export function collectRelayAudioAttachments(message, maxAttachments = 2) {
  const requestedLimit = Number(maxAttachments);
  const limit = Math.max(0, Math.min(Number.isFinite(requestedLimit) ? requestedLimit : 2, 10));
  const references = [];
  const seen = new Set();

  for (const attachment of values(message?.attachments)) {
    const safeUrl = discordCdnUrl(attachment.url);
    if (!safeUrl || seen.has(safeUrl) || references.length >= limit) continue;
    if (!supportedAudioReference({ contentType: attachment.contentType, filename: attachment.name })) continue;
    seen.add(safeUrl);
    references.push({
      source: "attachment",
      url: safeUrl,
      filename: attachment.name ? String(attachment.name).slice(0, 200) : null,
      contentType: normalizedType(attachment.contentType) || null,
      size: optionalNumber(attachment.size),
      durationSeconds: optionalNumber(attachment.durationSeconds ?? attachment.duration_secs ?? attachment.duration),
    });
  }

  return references;
}

export function publicRelayImageAttachment(reference, index) {
  return {
    index,
    source: reference.source,
    filename: reference.filename,
    contentType: reference.contentType,
    size: reference.size,
    width: reference.width,
    height: reference.height,
  };
}

export function publicRelayTextAttachment(reference, index) {
  return {
    index,
    source: reference.source,
    filename: reference.filename,
    contentType: reference.contentType,
    size: reference.size,
  };
}

export function publicRelayAudioAttachment(reference, index) {
  return {
    index,
    source: reference.source,
    filename: reference.filename,
    contentType: reference.contentType,
    size: reference.size,
    durationSeconds: reference.durationSeconds ?? null,
  };
}

export async function fetchRelayImageAttachment(reference, {
  fetchImplementation = fetch,
  maxBytes = 8_000_000,
  timeoutMs = 15_000,
} = {}) {
  const byteLimit = Math.max(1_024, Math.min(Number(maxBytes) || 8_000_000, 20_000_000));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1_000, Number(timeoutMs) || 15_000));
  try {
    const image = await downloadDiscordImageAttachment({
      ...reference,
      name: reference?.filename,
    }, {
      fetchImplementation,
      maxBytes: byteLimit,
      signal: controller.signal,
      allowGif: true,
      limitName: "relay",
    });
    return { data: image.bytes.toString("base64"), mimeType: image.mimeType, size: image.bytes.length };
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchRelayAudioAttachment(reference, {
  fetchImplementation = fetch,
  maxBytes = 8_000_000,
  timeoutMs = 15_000,
} = {}) {
  const byteLimit = Math.max(1_024, Math.min(Number(maxBytes) || 8_000_000, 20_000_000));
  const safeUrl = discordCdnUrl(reference?.url);
  if (!safeUrl) throw new Error("Discord audio attachment must use an approved HTTPS Discord CDN or proxy URL.");
  if (!supportedAudioReference({ contentType: reference?.contentType, filename: reference?.filename })) {
    throw new Error("Discord attachment is not a supported audio file.");
  }
  if (Number(reference?.size || 0) > byteLimit) {
    throw new Error(`Discord audio attachment '${reference?.filename || "file"}' exceeds the ${byteLimit}-byte relay limit.`);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1_000, Number(timeoutMs) || 15_000));
  try {
    const response = await fetchImplementation(safeUrl, { redirect: "error", signal: controller.signal });
    if (!response?.ok) throw new Error(`Discord audio attachment fetch failed with HTTP ${response?.status || "error"}.`);
    const declaredLength = Number(response.headers?.get?.("content-length") || 0);
    if (declaredLength > byteLimit) {
      throw new Error(`Discord audio attachment '${reference?.filename || "file"}' exceeds the ${byteLimit}-byte relay limit.`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > byteLimit) {
      throw new Error(`Discord audio attachment '${reference?.filename || "file"}' exceeds the ${byteLimit}-byte relay limit.`);
    }
    const sniffed = sniffAudio(bytes);
    if (!sniffed) throw new Error("Discord attachment response is not a supported audio file.");
    const declared = normalizedType(response.headers?.get?.("content-type")) || normalizedType(reference?.contentType);
    if (declared && !SUPPORTED_AUDIO_TYPES.has(declared) && !GENERIC_BINARY_TYPES.has(declared)) {
      throw new Error("Discord attachment response is not a supported audio file.");
    }
    return {
      data: bytes.toString("base64"),
      mimeType: sniffed,
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      durationSeconds: audioDurationSeconds(bytes, sniffed),
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchRelayTextAttachment(reference, {
  fetchImplementation = fetch,
  maxBytes = 256_000,
  timeoutMs = 15_000,
} = {}) {
  const byteLimit = Math.max(1_024, Math.min(Number(maxBytes) || 256_000, 1_000_000));
  const safeUrl = discordCdnUrl(reference?.url);
  if (!safeUrl) throw new Error("Discord text attachment must use an approved HTTPS Discord CDN or proxy URL.");
  if (!supportedTextReference({ contentType: reference?.contentType, filename: reference?.filename })) {
    throw new Error("Discord attachment is not a supported text file.");
  }
  if (Number(reference?.size || 0) > byteLimit) {
    throw new Error(`Discord text attachment '${reference?.filename || "file"}' exceeds the ${byteLimit}-byte relay limit.`);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1_000, Number(timeoutMs) || 15_000));
  try {
    const response = await fetchImplementation(safeUrl, { redirect: "error", signal: controller.signal });
    if (!response?.ok) throw new Error(`Discord text attachment fetch failed with HTTP ${response?.status || "error"}.`);
    const declaredLength = Number(response.headers?.get?.("content-length") || 0);
    if (declaredLength > byteLimit) {
      throw new Error(`Discord text attachment '${reference?.filename || "file"}' exceeds the ${byteLimit}-byte relay limit.`);
    }
    const contentType = normalizedType(response.headers?.get?.("content-type")) || normalizedType(reference?.contentType) || "text/plain";
    if (!supportedTextReference({ contentType, filename: reference?.filename })) {
      throw new Error("Discord attachment response is not a supported text file.");
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > byteLimit) {
      throw new Error(`Discord text attachment '${reference?.filename || "file"}' exceeds the ${byteLimit}-byte relay limit.`);
    }
    const text = bytes.toString("utf8");
    if (text.includes("\uFFFD")) throw new Error("Discord text attachment is not valid UTF-8 text.");
    return { text, mimeType: contentType, size: bytes.length };
  } finally {
    clearTimeout(timeout);
  }
}
