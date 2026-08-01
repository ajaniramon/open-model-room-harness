import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import { JsonlRequestLogger } from "../src/request-logger.js";

async function withTempDirectory(run) {
  const directory = await mkdtemp(join(tmpdir(), "jj-request-log-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("disabled request logging does not create a file", async () => {
  await withTempDirectory(async (directory) => {
    const path = join(directory, "traffic.jsonl");
    const logger = new JsonlRequestLogger({ enabled: false, path });
    await logger.log({ type: "model_request" });
    await assert.rejects(stat(path), { code: "ENOENT" });
  });
});

test("writes valid JSONL while redacting credentials and inline image data", async () => {
  await withTempDirectory(async (directory) => {
    const path = join(directory, "traffic.jsonl");
    const logger = new JsonlRequestLogger({ enabled: true, path });
    await logger.log({
      type: "model_request",
      authorization: "Bearer nope",
      body: {
        apiKey: "nope",
        messages: [{ content: "data:image/png;base64,AAAA" }],
      },
    });
    await logger.close();

    const record = JSON.parse((await readFile(path, "utf8")).trim());
    assert.equal(record.authorization, "[REDACTED]");
    assert.equal(record.body.apiKey, "[REDACTED]");
    assert.match(record.body.messages[0].content, /^\[data URL omitted: image\/png,/);
    assert.match(record.timestamp, /^\d{4}-\d{2}-\d{2}T/);
  });
});

test("serializes concurrent writes and gzip-rotates with bounded archives", async () => {
  await withTempDirectory(async (directory) => {
    const path = join(directory, "traffic.jsonl");
    const logger = new JsonlRequestLogger({
      enabled: true,
      path,
      maxBytes: 320,
      maxArchives: 2,
    });
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        logger.log({ type: "model_response", index, body: "x".repeat(90) }),
      ),
    );
    await logger.close();

    const files = await readdir(directory);
    const archives = files.filter((name) => name.endsWith(".jsonl.gz"));
    assert.equal(archives.length, 2);
    for (const archive of archives) {
      const lines = gunzipSync(await readFile(join(directory, archive)))
        .toString("utf8")
        .trim()
        .split("\n");
      for (const line of lines) assert.equal(JSON.parse(line).type, "model_response");
    }
    const activeLines = (await readFile(path, "utf8")).trim().split("\n");
    for (const line of activeLines) assert.equal(JSON.parse(line).type, "model_response");
  });
});
