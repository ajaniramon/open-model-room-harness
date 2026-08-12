import { downloadDiscordImageAttachment } from "./vision.js";

const SUPPORTED_IMAGE_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
]);

function normalizedType(value) {
  return String(value || "").split(";")[0].trim().toLowerCase();
}

function supportedImageReference({ contentType, filename }) {
  return SUPPORTED_IMAGE_TYPES.has(normalizedType(contentType)) || /\.(?:gif|jpe?g|png|webp)$/i.test(String(filename || ""));
}

function discordImageUrl(value) {
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
