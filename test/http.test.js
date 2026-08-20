import assert from "node:assert/strict";
import test from "node:test";
import { boundedFetch, readBoundedBuffer, readBoundedText } from "../src/http.js";
import { isRetryableRequestError } from "../src/retry.js";

function streamResponse(chunks, { status = 200, headers = {} } = {}) {
  let i = 0;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    body: {
      getReader: () => ({
        read: async () =>
          i < chunks.length
            ? { done: false, value: new Uint8Array(Buffer.from(chunks[i++])) }
            : { done: true, value: undefined },
        cancel: async () => {},
      }),
    },
    async text() {
      return chunks.join("");
    },
    async json() {
      return JSON.parse(chunks.join(""));
    },
  };
}

test("boundedFetch parses JSON on 2xx and stamps error.status on failure", async () => {
  const ok = await boundedFetch("https://x.test/a", {
    fetchImpl: async () => streamResponse(['{"a":1}']),
    parse: "json",
  });
  assert.deepEqual(ok, { a: 1 });

  const err = await boundedFetch("https://x.test/b", {
    fetchImpl: async () => streamResponse(["nope"], { status: 503 }),
    parse: "json",
    label: "Test",
  }).catch((e) => e);
  assert.equal(err.status, 503);
  assert.match(err.message, /Test returned HTTP 503/);
  assert.equal(isRetryableRequestError(err), true, "a 503 must classify as retryable");
});

test("boundedFetch passes redirect and abort signal through to fetch", async () => {
  let seen;
  await boundedFetch("https://x.test/c", {
    fetchImpl: async (_url, init) => {
      seen = init;
      return streamResponse(["ok"], { headers: { "content-type": "text/plain" } });
    },
    parse: "text",
    redirect: "error",
  });
  assert.equal(seen.redirect, "error");
  assert.ok(seen.signal, "an AbortSignal is always supplied");
});

test("a client timeout aborts and surfaces as a retryable AbortError", async () => {
  const err = await boundedFetch("https://x.test/slow", {
    timeoutMs: 10,
    fetchImpl: (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          const e = new Error("aborted");
          e.name = "AbortError";
          reject(e);
        });
      }),
  }).catch((e) => e);
  assert.equal(err.name, "AbortError");
  assert.equal(isRetryableRequestError(err), true);
});

test("readBoundedBuffer cancels the stream once it passes the byte budget", async () => {
  const response = streamResponse(["aaaa", "bbbb", "cccc"]);
  await assert.rejects(
    readBoundedBuffer(response, 6, "Payload"),
    /Payload exceeds the 6-byte limit/,
  );

  const within = streamResponse(["hello ", "world"]);
  const buf = await readBoundedBuffer(within, 1_000);
  assert.equal(buf.toString(), "hello world");
});

test("readBoundedBuffer rejects up front when content-length already exceeds the cap", async () => {
  const response = streamResponse(["x"], { headers: { "content-length": "999999" } });
  await assert.rejects(readBoundedBuffer(response, 1_000, "Blob"), /Blob exceeds/);
});

test("readBoundedText decodes the bounded buffer as UTF-8", async () => {
  const response = streamResponse(["caf", "é"]);
  assert.equal(await readBoundedText(response, 1_000), "café");
});
