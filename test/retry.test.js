import assert from "node:assert/strict";
import test from "node:test";
import { isRetryableRequestError, retry, RETRYABLE_HTTP_STATUS } from "../src/retry.js";

test("returns the first successful result without sleeping", async () => {
  const sleeps = [];
  const result = await retry(async () => "ok", {
    sleep: async (ms) => sleeps.push(ms),
  });
  assert.equal(result, "ok");
  assert.deepEqual(sleeps, []);
});

test("retries with exponential backoff until the attempts run out", async () => {
  const sleeps = [];
  let calls = 0;
  await assert.rejects(
    retry(
      async () => {
        calls += 1;
        throw new Error(`boom ${calls}`);
      },
      { attempts: 4, backoffMs: 100, sleep: async (ms) => sleeps.push(ms) },
    ),
    /boom 4/,
  );
  assert.equal(calls, 4);
  assert.deepEqual(sleeps, [100, 200, 400]);
});

test("caps the backoff and adds deterministic jitter", async () => {
  const sleeps = [];
  await assert.rejects(
    retry(
      async () => {
        throw new Error("always");
      },
      {
        attempts: 3,
        backoffMs: 5_000,
        maxBackoffMs: 6_000,
        jitterMs: 100,
        random: () => 0.5,
        sleep: async (ms) => sleeps.push(ms),
      },
    ),
  );
  assert.deepEqual(sleeps, [5_050, 6_050]);
});

test("a non-retryable error stops immediately and skips onRetry", async () => {
  let calls = 0;
  let retriedWith = null;
  await assert.rejects(
    retry(
      async () => {
        calls += 1;
        const error = new Error("terminal");
        error.status = 400;
        throw error;
      },
      {
        attempts: 3,
        shouldRetry: (error) => RETRYABLE_HTTP_STATUS.has(error.status),
        onRetry: (error) => {
          retriedWith = error;
        },
        sleep: async () => undefined,
      },
    ),
    /terminal/,
  );
  assert.equal(calls, 1);
  assert.equal(retriedWith, null);
});

test("onRetry runs between attempts and can mutate shared state", async () => {
  const corrections = [];
  let calls = 0;
  const result = await retry(
    async () => {
      calls += 1;
      if (calls === 1) {
        const error = new Error("bad output");
        error.rawOutput = "junk";
        throw error;
      }
      return `fixed after ${corrections.length} correction(s)`;
    },
    {
      attempts: 2,
      backoffMs: 0,
      onRetry: (error) => corrections.push(error.rawOutput),
      sleep: async () => undefined,
    },
  );
  assert.equal(result, "fixed after 1 correction(s)");
  assert.deepEqual(corrections, ["junk"]);
});

test("classifies throttling, server, timeout, and network failures as retryable", () => {
  for (const status of [429, 500, 502, 503, 504]) {
    const error = new Error("http");
    error.status = status;
    assert.equal(isRetryableRequestError(error), true, `HTTP ${status}`);
  }
  const badRequest = new Error("http");
  badRequest.status = 400;
  assert.equal(isRetryableRequestError(badRequest), false);

  const abort = new Error("timed out");
  abort.name = "AbortError";
  assert.equal(isRetryableRequestError(abort), true);
  assert.equal(isRetryableRequestError(new TypeError("fetch failed")), true);
  assert.equal(isRetryableRequestError(new Error("logic bug")), false);
});
