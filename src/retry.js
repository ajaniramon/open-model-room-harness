// One retry engine for every outbound call: text inference, TTS, image
// generation, X discovery, and semantic retries such as invalid image prompts.
// The loop never knows what it is retrying; everything that varies lives in the
// policy so the bridge and the harness can share the exact same behavior.

export const RETRYABLE_HTTP_STATUS = new Set([429, 500, 502, 503, 504]);

const defaultSleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

// Network-shaped failures worth one more attempt: throttling/5xx statuses
// (stamped on the error as `status`), timeouts, and fetch connection errors.
export function isRetryableRequestError(error) {
  return (
    RETRYABLE_HTTP_STATUS.has(error?.status) ||
    error?.name === "AbortError" ||
    error instanceof TypeError
  );
}

export async function retry(
  operation,
  {
    attempts = 2,
    backoffMs = 700,
    maxBackoffMs = 8_000,
    jitterMs = 0,
    shouldRetry = () => true,
    onRetry = () => undefined,
    sleep = defaultSleep,
    random = Math.random,
    label = "operation",
  } = {},
) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !shouldRetry(error, attempt)) throw error;
      const delay =
        Math.min(backoffMs * 2 ** (attempt - 1), maxBackoffMs) +
        (jitterMs > 0 ? Math.floor(random() * jitterMs) : 0);
      await onRetry(error, attempt, delay);
      if (delay > 0) await sleep(delay);
    }
  }
  throw lastError || new Error(`${label} failed after ${attempts} attempts`);
}
