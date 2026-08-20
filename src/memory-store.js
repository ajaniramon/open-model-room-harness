import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

const DAY_MS = 86_400_000;
export const PRIVACY_LEVELS = Object.freeze(["room", "guild", "owner"]);

export function createMemoryId() {
  return `mem_${randomBytes(8).toString("hex")}`;
}

// Memory text is distilled from untrusted Discord messages and is later replayed
// inside a labelled block. Collapsing whitespace and neutralizing brackets stops a
// stored memory from forging its own application header or block boundary.
export function sanitizeMemoryText(value, maxChars) {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .replaceAll("[", "(")
    .replaceAll("]", ")")
    .trim();
  return text.length > maxChars ? `${text.slice(0, maxChars - 1).trimEnd()}…` : text;
}

export function normalizeKeys(keys, limit = 8) {
  const seen = new Set();
  for (const key of Array.isArray(keys) ? keys : []) {
    const clean = String(key || "").toLowerCase().replace(/\s+/g, " ").trim();
    if (clean.length >= 2 && clean.length <= 60) seen.add(clean);
    if (seen.size >= limit) break;
  }
  return [...seen];
}

export class MemoryStore {
  constructor({
    path,
    maxRecords = 5_000,
    maxPerUser = 300,
    retentionDays = 180,
    maxTextChars = 300,
    now = Date.now,
    auditLogger = null,
    logger = console,
  }) {
    this.path = path;
    this.maxRecords = maxRecords;
    this.maxPerUser = maxPerUser;
    this.retentionDays = retentionDays;
    this.maxTextChars = maxTextChars;
    this.now = now;
    this.auditLogger = auditLogger;
    this.logger = logger;
    this.records = new Map();
    this.optedOut = new Set();
    this.appendedLines = 0;
    this.writes = Promise.resolve();
  }

  async load() {
    let raw;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") {
        this.logger.warn?.(`Could not load memory store: ${error.message || error}`);
      }
      return this;
    }
    let skipped = 0;
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      this.appendedLines += 1;
      try {
        if (!this.#apply(JSON.parse(line))) skipped += 1;
      } catch {
        skipped += 1;
      }
    }
    // A supersededBy pointing at a record that never loaded would hide the pointer's
    // owner forever; clear those danglers so the file stays safely hand-editable.
    for (const record of this.records.values()) {
      if (record.supersededBy && !this.records.has(record.supersededBy)) {
        record.supersededBy = null;
      }
    }
    if (skipped) this.logger.warn?.(`Skipped ${skipped} malformed memory entries.`);
    await this.sweep();
    return this;
  }

  #isWellFormed(record) {
    return (
      record &&
      typeof record.id === "string" &&
      typeof record.text === "string" &&
      typeof record.createdAt === "string" &&
      Array.isArray(record.keys) &&
      record.subject &&
      typeof record.subject.userId === "string" &&
      record.scope &&
      PRIVACY_LEVELS.includes(record.privacy)
    );
  }

  // Returns false for a rejected/malformed entry so load() can count it as skipped.
  #apply(entry) {
    if (entry?.op === "put") {
      if (!this.#isWellFormed(entry.record)) return false;
      const record = entry.record;
      this.records.set(record.id, record);
      const supersedes = this.records.get(record.supersedes);
      if (supersedes) supersedes.supersededBy = record.id;
      return true;
    }
    if (entry?.op === "delete" && entry.id) {
      this.records.delete(entry.id);
      return true;
    }
    if (entry?.op === "consent" && entry.userId) {
      if (entry.enabled === false) this.optedOut.add(String(entry.userId));
      else this.optedOut.delete(String(entry.userId));
      return true;
    }
    return false;
  }

  isOptedOut(userId) {
    return this.optedOut.has(String(userId || ""));
  }

  async setConsent(userId, enabled) {
    const id = String(userId || "");
    if (!id) return false;
    if (enabled === false) this.optedOut.add(id);
    else this.optedOut.delete(id);
    await this.#write({ op: "consent", at: this.#stamp(), userId: id, enabled: enabled !== false });
    await this.#audit("memory_consent_changed", { userId: id, enabled: enabled !== false });
    return true;
  }

  // Live records only: not deleted, not superseded, not expired.
  active({ guildId = undefined, subjectUserId = undefined } = {}) {
    const expiry = this.retentionDays ? this.now() - this.retentionDays * DAY_MS : null;
    const result = [];
    for (const record of this.records.values()) {
      if (record.supersededBy) continue;
      if (expiry && Date.parse(record.createdAt) < expiry) continue;
      if (guildId !== undefined && record.scope.guildId !== guildId) continue;
      if (subjectUserId !== undefined && record.subject.userId !== subjectUserId) continue;
      result.push(record);
    }
    return result;
  }

  history(id) {
    const chain = [];
    let current = this.records.get(id);
    while (current) {
      chain.push(current);
      current = current.supersedes ? this.records.get(current.supersedes) : null;
    }
    return chain;
  }

  async remember({
    text,
    subject,
    scope = {},
    privacy = "guild",
    keys = [],
    significance = 3,
    source = {},
    supersedes = null,
  }) {
    const clean = sanitizeMemoryText(text, this.maxTextChars);
    if (clean.length < 3) throw new Error("A memory needs at least 3 characters of text.");
    if (!subject?.userId) throw new Error("A memory needs a subject user ID.");
    const level = PRIVACY_LEVELS.includes(privacy) ? privacy : "guild";
    const createdAt = this.#stamp();
    const record = {
      id: createMemoryId(),
      kind: "fact",
      text: clean,
      keys: normalizeKeys(keys.length ? keys : clean.split(/[\s,.;:]+/).filter((word) => word.length > 4)),
      // The display name is an attacker-controlled guild nickname rendered into the
      // block, so it goes through the same neutralization as the note text.
      subject: {
        userId: String(subject.userId),
        displayName: sanitizeMemoryText(subject.displayName || "", 64),
      },
      scope: {
        guildId: scope.guildId ? String(scope.guildId) : null,
        channelId: level === "room" && scope.channelId ? String(scope.channelId) : null,
      },
      privacy: level,
      significance: Math.min(5, Math.max(1, Number(significance) || 3)),
      createdAt,
      validFrom: createdAt,
      supersedes: supersedes && this.records.has(supersedes) ? supersedes : null,
      supersededBy: null,
      source: {
        channelId: source.channelId ? String(source.channelId) : null,
        messageId: source.messageId ? String(source.messageId) : null,
        origin: source.origin === "extraction" ? "extraction" : "explicit",
      },
      embedding: null,
      useCount: 0,
    };
    this.records.set(record.id, record);
    if (record.supersedes) this.records.get(record.supersedes).supersededBy = record.id;
    await this.#write({ op: "put", at: createdAt, record });
    await this.#audit("memory_stored", {
      id: record.id,
      subjectUserId: record.subject.userId,
      guildId: record.scope.guildId,
      privacy: record.privacy,
      origin: record.source.origin,
      chars: record.text.length,
    });
    await this.#enforceLimits(record.subject.userId);
    return record;
  }

  async forget(ids) {
    const list = (Array.isArray(ids) ? ids : [ids]).filter((id) => this.records.has(id));
    for (const id of list) {
      // Deleting a correction must not bury the fact it superseded: resurrect the
      // predecessor so a wrong correction can be undone with `forget <id>` instead
      // of leaving the original invisible forever.
      const doomed = this.records.get(id);
      const parent = doomed?.supersedes ? this.records.get(doomed.supersedes) : null;
      this.records.delete(id);
      await this.#write({ op: "delete", at: this.#stamp(), id });
      if (parent && parent.supersededBy === id) {
        parent.supersededBy = null;
        await this.#write({ op: "put", at: this.#stamp(), record: parent });
      }
    }
    if (list.length) await this.#audit("memory_deleted", { ids: list, count: list.length });
    return list.length;
  }

  async forgetSubject(userId, { guildId = undefined } = {}) {
    const ids = [...this.records.values()]
      .filter(
        (record) =>
          record.subject.userId === String(userId) &&
          (guildId === undefined || record.scope.guildId === guildId),
      )
      .map((record) => record.id);
    return this.forget(ids);
  }

  async forgetGuild(guildId) {
    const ids = [...this.records.values()]
      .filter((record) => record.scope.guildId === String(guildId))
      .map((record) => record.id);
    const removed = await this.forget(ids);
    if (removed) await this.#audit("memory_guild_purged", { guildId: String(guildId), count: removed });
    return removed;
  }

  exportSubject(userId) {
    const records = [...this.records.values()]
      .filter((record) => record.subject.userId === String(userId))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return JSON.stringify(
      { exportedAt: this.#stamp(), subjectUserId: String(userId), count: records.length, records },
      null,
      2,
    );
  }

  async sweep() {
    if (!this.retentionDays) return 0;
    const expiry = this.now() - this.retentionDays * DAY_MS;
    const expired = [...this.records.values()]
      .filter((record) => Date.parse(record.createdAt) < expiry)
      .map((record) => record.id);
    if (!expired.length) return 0;
    const removed = await this.forget(expired);
    await this.#audit("memory_retention_sweep", { count: removed });
    return removed;
  }

  async close() {
    await this.writes;
    await this.auditLogger?.close();
  }

  // Eviction is permanent deletion, so it must not drop a live correction and keep
  // a stale alarm: dead records (superseded/expired) go first, then live records are
  // trimmed recency-first — the same order retrieval uses, so what survives on disk
  // matches what would have been recalled.
  #evictionRank(records) {
    const expiry = this.retentionDays ? this.now() - this.retentionDays * DAY_MS : null;
    const isDead = (record) =>
      Boolean(record.supersededBy) || (expiry !== null && Date.parse(record.createdAt) < expiry);
    return [...records].sort(
      (a, b) =>
        Number(isDead(b)) - Number(isDead(a)) ||
        a.createdAt.localeCompare(b.createdAt) ||
        a.significance - b.significance,
    );
  }

  async #enforceLimits(userId) {
    const overflow = new Set();
    const mine = this.#evictionRank(
      [...this.records.values()].filter((record) => record.subject.userId === userId),
    );
    // Rank puts the least-worth-keeping first; the survivors are the tail.
    for (const record of mine.slice(0, Math.max(0, mine.length - this.maxPerUser))) {
      overflow.add(record);
    }
    if (this.records.size - overflow.size > this.maxRecords) {
      const all = this.#evictionRank(
        [...this.records.values()].filter((record) => !overflow.has(record)),
      );
      for (const record of all.slice(0, Math.max(0, all.length - overflow.size - this.maxRecords))) {
        overflow.add(record);
      }
    }
    if (overflow.size) {
      await this.forget([...overflow].map((record) => record.id));
      await this.#audit("memory_evicted", { count: overflow.size });
    }
  }

  #stamp() {
    return new Date(this.now()).toISOString();
  }

  async #write(entry) {
    this.writes = this.writes
      .catch(() => undefined)
      .then(async () => {
        await mkdir(dirname(this.path), { recursive: true });
        await appendFile(this.path, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
        this.appendedLines += 1;
        if (this.appendedLines > Math.max(200, this.records.size * 2)) await this.#compact();
      });
    await this.writes;
  }

  // The log is append-only, so deletions and supersessions leave dead lines behind.
  // Rewrite it once the file is mostly history.
  async #compact() {
    // Compaction is a free partial sweep: expired records are invisible to active()
    // but were being rewritten to disk on every compaction, so drop them here.
    const expiry = this.retentionDays ? this.now() - this.retentionDays * DAY_MS : null;
    const lines = [...this.records.values()]
      .filter((record) => expiry === null || Date.parse(record.createdAt) >= expiry)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((record) => JSON.stringify({ op: "put", at: record.createdAt, record }));
    for (const userId of this.optedOut) {
      lines.push(JSON.stringify({ op: "consent", at: this.#stamp(), userId, enabled: false }));
    }
    const temporaryPath = `${this.path}.${process.pid}.${randomBytes(5).toString("hex")}.tmp`;
    await writeFile(temporaryPath, lines.length ? `${lines.join("\n")}\n` : "", {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, this.path);
    this.appendedLines = lines.length;
  }

  async #audit(type, details) {
    await this.auditLogger?.log({ type, ...details });
  }
}
