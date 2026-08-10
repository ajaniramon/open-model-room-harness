import { randomUUID } from "node:crypto";
import { watch } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

export const BEHAVIOR_MODES = Object.freeze(["manual", "observe", "auto", "quiet"]);
const BEHAVIOR_MODE_SET = new Set(BEHAVIOR_MODES);

export const DEFAULT_BEHAVIOR_MODE_SETTINGS = Object.freeze({
  enabled: false,
  defaultMode: "manual",
  statePath: "state/behavior-mode.json",
  auto: Object.freeze({
    cooldownSeconds: 180,
    maxRepliesPerHour: 8,
  }),
});

function normalizeMode(mode, label = "mode") {
  const value = String(mode || "").trim().toLowerCase();
  if (!BEHAVIOR_MODE_SET.has(value)) {
    throw new Error(`${label} must be one of: ${BEHAVIOR_MODES.join(", ")}`);
  }
  return value;
}

function optionalString(value) {
  const result = String(value || "").trim();
  return result || null;
}

function optionalTimestamp(value, now) {
  if (value === undefined || value === null || value === "") return null;
  if (Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value));
  if (!Number.isFinite(parsed)) throw new Error("expiresAt must be an ISO timestamp or epoch milliseconds");
  if (parsed <= now) throw new Error("expiresAt must be in the future");
  return parsed;
}

function optionalDuration(value, now) {
  if (value === undefined || value === null || value === "") return null;
  const minutes = Number(value);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 10_080) {
    throw new Error("durationMinutes must be an integer between 1 and 10080");
  }
  return now + minutes * MINUTE_MS;
}

function optionalInteger(value, fallback, label, min, max) {
  if (value === undefined || value === null || value === "") return fallback;
  const result = Number(value);
  if (!Number.isInteger(result) || result < min || result > max) {
    throw new Error(`${label} must be an integer between ${min} and ${max}`);
  }
  return result;
}

function normalizeScope(scope = {}) {
  const guildId = optionalString(scope.guildId);
  const channelId = optionalString(scope.channelId);
  if (channelId) return { type: "channel", guildId, channelId };
  if (guildId) return { type: "guild", guildId, channelId: null };
  return { type: "global", guildId: null, channelId: null };
}

function scopeKey(scope) {
  if (scope.type === "channel") return `channel:${scope.channelId}`;
  if (scope.type === "guild") return `guild:${scope.guildId}`;
  return "global";
}

function normalizeEntry(input, defaults, now) {
  const mode = normalizeMode(input?.mode || defaults.defaultMode);
  const expiresAt =
    optionalTimestamp(input?.expiresAt, now) ||
    optionalDuration(input?.durationMinutes, now);
  const cooldownSeconds = optionalInteger(
    input?.cooldownSeconds,
    defaults.auto.cooldownSeconds,
    "cooldownSeconds",
    0,
    86_400,
  );
  const maxRepliesPerHour = optionalInteger(
    input?.maxRepliesPerHour,
    defaults.auto.maxRepliesPerHour,
    "maxRepliesPerHour",
    0,
    500,
  );
  return {
    mode,
    expiresAt,
    cooldownSeconds,
    maxRepliesPerHour,
    updatedAt: new Date(now).toISOString(),
  };
}

async function atomicJsonWrite(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const backupPath = `${path}.${process.pid}.${randomUUID()}.bak`;
  let backedUp = false;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    try {
      await rename(path, backupPath);
      backedUp = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await rename(temporaryPath, path);
    if (backedUp) await unlink(backupPath).catch(() => {});
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    if (backedUp) await rename(backupPath, path).catch(() => {});
    throw error;
  }
}

export class BehaviorModeController {
  constructor({ settings = {}, statePath = "", auditLogger = null, now = Date.now } = {}) {
    const defaults = {
      ...DEFAULT_BEHAVIOR_MODE_SETTINGS,
      ...settings,
      auto: {
        ...DEFAULT_BEHAVIOR_MODE_SETTINGS.auto,
        ...(settings.auto || {}),
      },
    };
    this.enabled = defaults.enabled === true;
    this.defaultMode = normalizeMode(defaults.defaultMode || "manual", "defaultMode");
    this.statePath = statePath || defaults.statePath;
    this.autoDefaults = {
      cooldownSeconds: optionalInteger(
        defaults.auto.cooldownSeconds,
        DEFAULT_BEHAVIOR_MODE_SETTINGS.auto.cooldownSeconds,
        "auto.cooldownSeconds",
        0,
        86_400,
      ),
      maxRepliesPerHour: optionalInteger(
        defaults.auto.maxRepliesPerHour,
        DEFAULT_BEHAVIOR_MODE_SETTINGS.auto.maxRepliesPerHour,
        "auto.maxRepliesPerHour",
        0,
        500,
      ),
    };
    this.auditLogger = auditLogger;
    this.now = now;
    this.entries = new Map();
    this.autoResponses = new Map();
    this.watcher = null;
    this.watchReloadTimer = null;
    this.reloading = Promise.resolve();
  }

  async load() {
    if (!this.enabled) return this;
    this.entries = await this.#readEntries();
    return this;
  }

  async startWatching() {
    if (!this.enabled || this.watcher) return this;
    await mkdir(dirname(this.statePath), { recursive: true });
    this.watcher = watch(dirname(this.statePath), (eventType, filename) => {
      if (filename && String(filename) !== this.statePath.split(/[\\/]/).pop()) return;
      clearTimeout(this.watchReloadTimer);
      this.watchReloadTimer = setTimeout(() => {
        this.reloading = this.reloading
          .then(async () => {
            this.entries = await this.#readEntries();
          })
          .catch((error) => {
            console.warn(`Could not reload behavior mode state: ${error.message || error}`);
          });
      }, 50);
    });
    this.watcher.unref?.();
    return this;
  }

  async #readEntries() {
    const entries = new Map();
    try {
      const payload = JSON.parse(await readFile(this.statePath, "utf8"));
      for (const item of Array.isArray(payload.entries) ? payload.entries : []) {
        const scope = normalizeScope(item);
        const expiresAt = item.expiresAt ? Date.parse(item.expiresAt) : null;
        if (expiresAt && expiresAt <= this.now()) continue;
        entries.set(scopeKey(scope), {
          ...scope,
          mode: normalizeMode(item.mode),
          expiresAt,
          cooldownSeconds: optionalInteger(
            item.cooldownSeconds,
            this.autoDefaults.cooldownSeconds,
            "cooldownSeconds",
            0,
            86_400,
          ),
          maxRepliesPerHour: optionalInteger(
            item.maxRepliesPerHour,
            this.autoDefaults.maxRepliesPerHour,
            "maxRepliesPerHour",
            0,
            500,
          ),
          updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : null,
        });
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        console.warn(`Could not load behavior mode state: ${error.message || error}`);
      }
    }
    return entries;
  }

  resolve(scope = {}) {
    if (!this.enabled) {
      return this.#resolved({
        mode: "manual",
        type: "global",
        guildId: null,
        channelId: null,
        source: "disabled",
      });
    }
    this.#expire();
    const normalized = normalizeScope(scope);
    const keys = [
      normalized.channelId ? `channel:${normalized.channelId}` : null,
      normalized.guildId ? `guild:${normalized.guildId}` : null,
      "global",
    ].filter(Boolean);
    for (const key of keys) {
      const entry = this.entries.get(key);
      if (entry) return this.#resolved({ ...entry, source: entry.type });
    }
    return this.#resolved({
      mode: this.defaultMode,
      type: "global",
      guildId: null,
      channelId: null,
      source: "default",
      cooldownSeconds: this.autoDefaults.cooldownSeconds,
      maxRepliesPerHour: this.autoDefaults.maxRepliesPerHour,
    });
  }

  list() {
    this.#expire();
    return [...this.entries.values()].map((entry) => this.#serialize(entry));
  }

  async setMode({ mode, guildId = null, channelId = null, durationMinutes = null, expiresAt = null, cooldownSeconds = null, maxRepliesPerHour = null } = {}, context = {}) {
    if (!this.enabled) throw new Error("Behavior modes are disabled");
    const now = this.now();
    const scope = normalizeScope({ guildId, channelId });
    const entry = {
      ...scope,
      ...normalizeEntry(
        {
          mode,
          expiresAt: expiresAt ?? optionalDuration(durationMinutes, now),
          cooldownSeconds,
          maxRepliesPerHour,
        },
        { defaultMode: this.defaultMode, auto: this.autoDefaults },
        now,
      ),
    };
    this.entries.set(scopeKey(scope), entry);
    await this.#persist();
    await this.#audit("behavior_mode_set", context, this.#serialize(entry));
    return this.#serialize(entry);
  }

  async clearMode({ guildId = null, channelId = null } = {}, context = {}) {
    if (!this.enabled) throw new Error("Behavior modes are disabled");
    const scope = normalizeScope({ guildId, channelId });
    const removed = this.entries.delete(scopeKey(scope));
    if (removed) await this.#persist();
    await this.#audit("behavior_mode_cleared", context, { ...scope, removed });
    return removed;
  }

  allowsNonOwnerReply(scope = {}) {
    return !new Set(["observe", "quiet"]).has(this.resolve(scope).mode);
  }

  allowsSpontaneousReply(scope = {}) {
    return this.resolve(scope).mode === "auto";
  }

  allowsMemoryCapture(scope = {}, captureMode = "observation") {
    const mode = this.resolve(scope).mode;
    if (mode === "quiet") return false;
    if (captureMode === "always") return true;
    return mode === "observe";
  }

  canRecordAutoResponse(scope = {}) {
    const resolved = this.resolve(scope);
    if (resolved.mode !== "auto") return { allowed: false, reason: "not_auto" };
    if (resolved.maxRepliesPerHour <= 0) return { allowed: false, reason: "auto_hourly_limit" };
    const key = scopeKey({
      type: resolved.scope === "default" || resolved.scope === "disabled" ? "global" : resolved.scope,
      guildId: resolved.guildId,
      channelId: resolved.channelId,
    });
    const now = this.now();
    const recent = (this.autoResponses.get(key) || []).filter((timestamp) => now - timestamp < HOUR_MS);
    if (recent.length >= resolved.maxRepliesPerHour) {
      this.autoResponses.set(key, recent);
      return { allowed: false, reason: "auto_hourly_limit" };
    }
    const last = recent.at(-1);
    if (last !== undefined && now - last < resolved.cooldownSeconds * 1_000) {
      this.autoResponses.set(key, recent);
      return { allowed: false, reason: "auto_cooldown" };
    }
    recent.push(now);
    this.autoResponses.set(key, recent);
    return { allowed: true };
  }

  async close() {
    clearTimeout(this.watchReloadTimer);
    this.watcher?.close();
    this.watcher = null;
    await this.reloading;
    await this.auditLogger?.close?.();
  }

  #resolved(entry) {
    return {
      mode: entry.mode,
      scope: entry.type,
      guildId: entry.guildId || null,
      channelId: entry.channelId || null,
      source: entry.source || entry.type,
      expiresAt: entry.expiresAt ? new Date(entry.expiresAt).toISOString() : null,
      cooldownSeconds: entry.cooldownSeconds ?? this.autoDefaults.cooldownSeconds,
      maxRepliesPerHour: entry.maxRepliesPerHour ?? this.autoDefaults.maxRepliesPerHour,
    };
  }

  #serialize(entry) {
    return {
      type: entry.type,
      guildId: entry.guildId || null,
      channelId: entry.channelId || null,
      mode: entry.mode,
      expiresAt: entry.expiresAt ? new Date(entry.expiresAt).toISOString() : null,
      cooldownSeconds: entry.cooldownSeconds,
      maxRepliesPerHour: entry.maxRepliesPerHour,
      updatedAt: entry.updatedAt,
    };
  }

  #expire() {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt && entry.expiresAt <= now) this.entries.delete(key);
    }
  }

  async #persist() {
    this.#expire();
    await atomicJsonWrite(this.statePath, { entries: this.list() });
  }

  async #audit(type, context, details) {
    await this.auditLogger?.log?.({
      type,
      userId: context.userId || null,
      username: context.username || null,
      guildId: context.guildId || details.guildId || null,
      channelId: context.channelId || details.channelId || null,
      ...details,
    });
  }
}
