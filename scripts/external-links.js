export const SILICON_DREAMER_URL = "https://www.newgrounds.com/audio/listen/1464248";

const APPROVED_EXTERNAL_URLS = new Set([SILICON_DREAMER_URL]);

export function isApprovedExternalUrl(value) {
  if (typeof value !== "string") return false;
  try {
    return APPROVED_EXTERNAL_URLS.has(new URL(value).href);
  } catch {
    return false;
  }
}
