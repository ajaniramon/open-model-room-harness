// One bounded outbound HTTP call for every fetcher in the harness: a timeout tied
// to an AbortController, an ok-check that stamps `error.status` so retry
// classification works, an optional redirect policy, and optional size-bounded
// body reads that cancel a stream past the byte budget instead of buffering it
// whole. Consolidating this makes the recurring defects — a missing timeout, a
// missing `redirect: "error"`, an unbounded body — properties of one helper.

// Reads a response body into a Buffer, cancelling the stream once it passes
// maxBytes rather than materializing an unbounded response first.
export async function readBoundedBuffer(response, maxBytes, label = "response") {
  const declared = Number(response.headers.get("content-length") || 0);
  if (maxBytes && declared > maxBytes) {
    throw new Error(`${label} exceeds the ${maxBytes}-byte limit.`);
  }
  if (!response.body?.getReader) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (maxBytes && bytes.length > maxBytes) {
      throw new Error(`${label} exceeds the ${maxBytes}-byte limit.`);
    }
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (maxBytes && size > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error(`${label} exceeds the ${maxBytes}-byte limit.`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, size);
}

export async function readBoundedText(response, maxBytes, label = "response") {
  const buffer = await readBoundedBuffer(response, maxBytes, label);
  return buffer.toString("utf8");
}

// parse: "response" leaves the body to the caller (timeout only covers headers);
// "json" | "text" | "buffer" read the body inside the timeout window. Pass
// maxBytes to bound text/buffer reads. Any non-2xx throws an Error carrying
// `.status`, so isRetryableRequestError can classify it.
export async function boundedFetch(
  url,
  {
    fetchImpl = fetch,
    timeoutMs = 30_000,
    redirect = "follow",
    label = "request",
    parse = "response",
    maxBytes = null,
    ...init
  } = {},
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...init, redirect, signal: controller.signal });
    if (!response.ok) {
      let detail = "";
      try {
        detail = (await response.text()).slice(0, 500);
      } catch {
        detail = "";
      }
      const error = new Error(`${label} returned HTTP ${response.status}${detail ? `: ${detail}` : "."}`);
      error.status = response.status;
      const retryAfter = Number(response.headers.get("retry-after"));
      if (Number.isFinite(retryAfter) && retryAfter > 0) error.retryAfterMs = retryAfter * 1_000;
      throw error;
    }
    if (parse === "json") return await response.json();
    if (parse === "text") return await readBoundedText(response, maxBytes, label);
    if (parse === "buffer") return await readBoundedBuffer(response, maxBytes, label);
    return response;
  } finally {
    clearTimeout(timer);
  }
}
