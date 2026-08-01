import { createReadStream, createWriteStream } from "node:fs";
import { appendFile, mkdir, readdir, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { randomUUID } from "node:crypto";

const SENSITIVE_KEY = /authorization|api[-_]?key|token|secret|password|cookie/i;
const DATA_URL = /^data:([^;,]+)[;,]/i;

function truncate(value, maxChars) {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}...[truncated ${value.length - maxChars} chars]`;
}

function sanitize(value, maxChars, seen = new WeakSet()) {
  if (typeof value === "string") {
    const dataUrl = DATA_URL.exec(value);
    if (dataUrl) return `[data URL omitted: ${dataUrl[1]}, ${value.length} chars]`;
    return truncate(value, maxChars);
  }
  if (value === null || typeof value !== "object") return value;
  if (Buffer.isBuffer(value)) return `[buffer omitted: ${value.length} bytes]`;
  if (value instanceof Error) {
    return { name: value.name, message: truncate(value.message, maxChars) };
  }
  if (seen.has(value)) return "[circular]";
  seen.add(value);

  if (Array.isArray(value)) return value.map((entry) => sanitize(entry, maxChars, seen));

  const clean = {};
  for (const [key, entry] of Object.entries(value)) {
    clean[key] = SENSITIVE_KEY.test(key) ? "[REDACTED]" : sanitize(entry, maxChars, seen);
  }
  return clean;
}

export class JsonlRequestLogger {
  constructor({
    enabled = false,
    path,
    maxBytes = 5 * 1024 * 1024,
    maxArchives = 5,
    includeBodies = true,
    maxValueChars = 100_000,
  }) {
    this.enabled = enabled;
    this.path = resolve(path);
    this.maxBytes = maxBytes;
    this.maxArchives = maxArchives;
    this.includeBodies = includeBodies;
    this.maxValueChars = maxValueChars;
    this.pending = Promise.resolve();
    this.reportedFailure = false;
  }

  log(event) {
    if (!this.enabled) return Promise.resolve();
    this.pending = this.pending
      .then(() => this.#write(event))
      .catch((error) => {
        if (!this.reportedFailure) {
          this.reportedFailure = true;
          console.error(`Request logger write failed; model traffic will continue: ${error.message}`);
        }
      });
    return this.pending;
  }

  async close() {
    await this.pending;
  }

  async #write(event) {
    const record = { timestamp: new Date().toISOString(), ...event };
    if (!this.includeBodies) delete record.body;
    const line = `${JSON.stringify(sanitize(record, this.maxValueChars))}\n`;
    const lineBytes = Buffer.byteLength(line);

    await mkdir(dirname(this.path), { recursive: true });
    const currentBytes = await stat(this.path).then((info) => info.size).catch((error) => {
      if (error.code === "ENOENT") return 0;
      throw error;
    });
    if (currentBytes > 0 && currentBytes + lineBytes > this.maxBytes) await this.#rotate();
    await appendFile(this.path, line, "utf8");
  }

  async #rotate() {
    const directory = dirname(this.path);
    const extension = extname(this.path);
    const stem = basename(this.path, extension);
    const suffix = `${new Date().toISOString().replace(/[:.]/g, "-")}.${randomUUID().slice(0, 8)}`;
    const rotatingPath = join(directory, `${stem}.${suffix}.rotating`);
    const archivePath = join(directory, `${stem}.${suffix}${extension}.gz`);

    await rename(this.path, rotatingPath);
    try {
      await pipeline(createReadStream(rotatingPath), createGzip(), createWriteStream(archivePath));
      await unlink(rotatingPath);
    } catch (error) {
      await unlink(archivePath).catch(() => {});
      await rename(rotatingPath, this.path).catch(() => {});
      throw error;
    }

    const archives = (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.startsWith(`${stem}.`) && entry.name.endsWith(`${extension}.gz`))
      .map((entry) => entry.name)
      .sort();
    for (const obsolete of archives.slice(0, Math.max(0, archives.length - this.maxArchives))) {
      await unlink(join(directory, obsolete));
    }
  }
}
