import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

export const DEFAULT_PARTICIPATION_POLICY = Object.freeze({
  enabled: true,
  budget: Object.freeze({ maxResponses: 12, windowMinutes: 10 }),
  conversation: Object.freeze({ turns: 5, idleMinutes: 10 }),
  cooldown: Object.freeze({
    baseSeconds: 3,
    multiplier: 2,
    maxSeconds: 60,
    decaySeconds: 120,
    resetMinutes: 10,
  }),
  autoban: Object.freeze({
    enabled: true,
    triggers: 8,
    windowSeconds: 20,
    cooldownRejections: 4,
    durationMinutes: 10,
    repeatWindowHours: 24,
    repeatDurationMinutes: 60,
    maxDurationMinutes: 360,
  }),
});

const POLICY_FIELDS = Object.freeze({
  enabled: { type: "boolean" },
  "budget.maxResponses": { min: 1, max: 500 },
  "budget.windowMinutes": { min: 1, max: 1_440 },
  "conversation.turns": { min: 1, max: 20 },
  "conversation.idleMinutes": { min: 1, max: 1_440 },
  "cooldown.baseSeconds": { min: 0, max: 3_600 },
  "cooldown.multiplier": { min: 1, max: 10 },
  "cooldown.maxSeconds": { min: 0, max: 86_400 },
  "cooldown.decaySeconds": { min: 1, max: 86_400 },
  "cooldown.resetMinutes": { min: 1, max: 1_440 },
  "autoban.enabled": { type: "boolean" },
  "autoban.triggers": { min: 3, max: 100 },
  "autoban.windowSeconds": { min: 5, max: 3_600 },
  "autoban.cooldownRejections": { min: 1, max: 100 },
  "autoban.durationMinutes": { min: 1, max: 10_080 },
  "autoban.repeatWindowHours": { min: 1, max: 8_760 },
  "autoban.repeatDurationMinutes": { min: 1, max: 10_080 },
  "autoban.maxDurationMinutes": { min: 1, max: 43_200 },
});

function integer(value, fallback, label, min, max) {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(result) || result < min || result > max) {
    throw new Error(`${label} must be an integer between ${min} and ${max}`);
  }
  return result;
}
function boolean(value, fallback, label) {
  const result = value === undefined ? fallback : value;
  if (typeof result === "boolean") return result;
  if (String(result).toLowerCase() === "true") return true;
  if (String(result).toLowerCase() === "false") return false;
  throw new Error(`${label} must be true or false`);
}

export function normalizeParticipationPolicy(input = {}) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const policy = {
    enabled: boolean(source.enabled, DEFAULT_PARTICIPATION_POLICY.enabled, "participation.enabled"),
    budget: {
      maxResponses: integer(source.budget?.maxResponses, 12, "budget.maxResponses", 1, 500),
      windowMinutes: integer(source.budget?.windowMinutes, 10, "budget.windowMinutes", 1, 1_440),
    },
    conversation: {
      turns: integer(source.conversation?.turns, 5, "conversation.turns", 1, 20),
      idleMinutes: integer(source.conversation?.idleMinutes, 10, "conversation.idleMinutes", 1, 1_440),
    },
    cooldown: {
      baseSeconds: integer(source.cooldown?.baseSeconds, 3, "cooldown.baseSeconds", 0, 3_600),
      multiplier: integer(source.cooldown?.multiplier, 2, "cooldown.multiplier", 1, 10),
      maxSeconds: integer(source.cooldown?.maxSeconds, 60, "cooldown.maxSeconds", 0, 86_400),
      decaySeconds: integer(source.cooldown?.decaySeconds, 120, "cooldown.decaySeconds", 1, 86_400),
      resetMinutes: integer(source.cooldown?.resetMinutes, 10, "cooldown.resetMinutes", 1, 1_440),
    },
    autoban: {
      enabled: boolean(source.autoban?.enabled, true, "autoban.enabled"),
      triggers: integer(source.autoban?.triggers, 8, "autoban.triggers", 3, 100),
      windowSeconds: integer(source.autoban?.windowSeconds, 20, "autoban.windowSeconds", 5, 3_600),
      cooldownRejections: integer(source.autoban?.cooldownRejections, 4, "autoban.cooldownRejections", 1, 100),
      durationMinutes: integer(source.autoban?.durationMinutes, 10, "autoban.durationMinutes", 1, 10_080),
      repeatWindowHours: integer(source.autoban?.repeatWindowHours, 24, "autoban.repeatWindowHours", 1, 8_760),
      repeatDurationMinutes: integer(source.autoban?.repeatDurationMinutes, 60, "autoban.repeatDurationMinutes", 1, 10_080),
      maxDurationMinutes: integer(source.autoban?.maxDurationMinutes, 360, "autoban.maxDurationMinutes", 1, 43_200),
    },
  };
  if (policy.cooldown.maxSeconds < policy.cooldown.baseSeconds) {
    throw new Error("cooldown.maxSeconds must be at least cooldown.baseSeconds");
  }
  if (policy.autoban.cooldownRejections > policy.autoban.triggers) {
    throw new Error("autoban.cooldownRejections cannot exceed autoban.triggers");
  }
  if (policy.autoban.maxDurationMinutes < policy.autoban.durationMinutes) {
    throw new Error("autoban.maxDurationMinutes must be at least autoban.durationMinutes");
  }
  return policy;
}

export function parseParticipationCommand(content) {
  const source = String(content || "");
  const mentionedIds = [...source.matchAll(/<@!?(\d{15,22})>/g)].map((match) => match[1]);
  const clean = source.replace(/<@!?\d{15,22}>/g, " ").replace(/\s+/g, " ").trim();
  if (/^limits\s+show$/i.test(clean)) return { action: "show" };
  if (/^limits\s+reset$/i.test(clean)) return { action: "reset" };
  const set = /^limits\s+set\s+([a-z][a-z0-9.]*)\s+(.+)$/i.exec(clean);
  if (set) return { action: "set", path: set[1], value: set[2].trim() };
  const unban = /^limits\s+unban(?:\s+(\d{15,22}))?$/i.exec(clean);
  if (unban) {
    const userId = unban[1] || mentionedIds.at(-1) || "";
    return { action: "unban", userId };
  }
  return null;
}

function nestedSet(source, dottedPath, value) {
  const result = structuredClone(source);
  const parts = dottedPath.split(".");
  let cursor = result;
  for (const part of parts.slice(0, -1)) cursor = cursor[part];
  cursor[parts.at(-1)] = value;
  return result;
}

function parsePolicyValue(path, rawValue) {
  const definition = POLICY_FIELDS[path];
  if (!definition) throw new Error(`Unknown participation setting: ${path}`);
  if (definition.type === "boolean") return boolean(rawValue, false, path);
  return integer(rawValue, undefined, path, definition.min, definition.max);
}

async function atomicJsonWrite(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const backupPath = `${path}.${process.pid}.${randomUUID()}.bak`;
  let backedUp = false;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
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

export class ParticipationController {
  constructor({ policy, configPath, statePath, auditLogger = null, now = Date.now }) {
    this.policy = normalizeParticipationPolicy(policy);
    this.configPath = configPath;
    this.statePath = statePath;
    this.auditLogger = auditLogger;
    this.now = now;
    this.budgets = new Map();
    this.cooldowns = new Map();
    this.sessions = new Map();
    this.spamAttempts = new Map();
    this.bans = new Map();
    this.offenses = new Map();
    this.reservations = new Map();
    this.persistence = Promise.resolve();
  }

  get enabled() {
    return this.policy.enabled;
  }

  async load() {
    try {
      const state = JSON.parse(await readFile(this.statePath, "utf8"));
      for (const ban of Array.isArray(state.bans) ? state.bans : []) {
        if (ban?.guildId && ban?.userId && Number.isFinite(ban.expiresAt)) {
          this.bans.set(this.#userKey(ban.guildId, ban.userId), ban);
        }
      }
      for (const offense of Array.isArray(state.offenses) ? state.offenses : []) {
        if (offense?.guildId && offense?.userId && Number.isFinite(offense.lastAt)) {
          this.offenses.set(this.#userKey(offense.guildId, offense.userId), offense);
        }
      }
      await this.#removeExpiredBans(this.now());
    } catch (error) {
      if (error.code !== "ENOENT") console.warn(`Could not load participation state: ${error.message}`);
    }
    return this;
  }

  isOwner(author, config) {
    const id = String(author?.id || "");
    const username = String(author?.username || "").toLowerCase();
    return config.ownerUserIds.has(id) || config.ownerUsernames.has(username);
  }

  hasActiveConversation({ guildId, channelId, userId, isOwner = false }) {
    if (!this.enabled || !guildId) return false;
    const key = this.#sessionKey(guildId, channelId, userId);
    const session = this.sessions.get(key);
    if (!session) return false;
    const idleMs = this.policy.conversation.idleMinutes * MINUTE_MS;
    if (this.now() - session.lastActivityAt >= idleMs || (!isOwner && session.remaining <= 0)) {
      this.sessions.delete(key);
      return false;
    }
    return true;
  }

  async reserve({
    guildId,
    channelId,
    userId,
    username = "",
    isOwner = false,
    explicitMention = false,
    continuation = false,
    kind = "direct",
  }) {
    const now = this.now();
    const reservation = {
      id: randomUUID(), guildId, channelId, userId, username, isOwner,
      explicitMention, continuation, kind, createdAt: now,
    };
    if (!this.enabled || isOwner || !guildId) {
      this.reservations.set(reservation.id, reservation);
      return { allowed: true, reservationId: reservation.id };
    }

    const userKey = this.#userKey(guildId, userId);
    const ban = await this.#activeBan(userKey, now);
    if (ban) return this.#deny("temporary_ban", reservation, { expiresAt: ban.expiresAt });

    let attempt = null;
    if (explicitMention && kind === "direct") {
      attempt = { at: now, rejectedByCooldown: false };
      const windowMs = this.policy.autoban.windowSeconds * 1_000;
      const attempts = (this.spamAttempts.get(userKey) || []).filter((item) => now - item.at < windowMs);
      attempts.push(attempt);
      this.spamAttempts.set(userKey, attempts);
    }

    if (kind === "direct") {
      const cooldown = this.cooldowns.get(userKey);
      if (cooldown?.until > now) {
        if (attempt) attempt.rejectedByCooldown = true;
        const autoban = await this.#maybeAutoban(reservation, userKey, now);
        return this.#deny(autoban ? "spam_autoban" : "user_cooldown", reservation, {
          retryAt: autoban?.expiresAt || cooldown.until,
        });
      }
    }

    const windowMs = this.policy.budget.windowMinutes * MINUTE_MS;
    const timestamps = (this.budgets.get(guildId) || []).filter((timestamp) => now - timestamp < windowMs);
    this.budgets.set(guildId, timestamps);
    const pending = [...this.reservations.values()].filter(
      (item) => !item.isOwner && item.guildId === guildId,
    ).length;
    if (timestamps.length + pending >= this.policy.budget.maxResponses) {
      return this.#deny("global_budget", reservation, {});
    }

    this.reservations.set(reservation.id, reservation);
    return { allowed: true, reservationId: reservation.id };
  }

  async commit(reservationId) {
    const reservation = this.reservations.get(reservationId);
    if (!reservation) return false;
    this.reservations.delete(reservationId);
    const now = this.now();
    if (!this.enabled || !reservation.guildId) return true;

    if (!reservation.isOwner) {
      const timestamps = this.budgets.get(reservation.guildId) || [];
      timestamps.push(now);
      this.budgets.set(reservation.guildId, timestamps);
    }

    if (reservation.kind === "direct") {
      const sessionKey = this.#sessionKey(reservation.guildId, reservation.channelId, reservation.userId);
      if (reservation.explicitMention) {
        this.sessions.set(sessionKey, {
          remaining: reservation.isOwner ? Number.MAX_SAFE_INTEGER : Math.max(0, this.policy.conversation.turns - 1),
          lastActivityAt: now,
        });
      } else if (reservation.continuation) {
        const session = this.sessions.get(sessionKey);
        if (session) {
          if (!reservation.isOwner) session.remaining -= 1;
          session.lastActivityAt = now;
          if (!reservation.isOwner && session.remaining <= 0) this.sessions.delete(sessionKey);
        }
      }

      if (!reservation.isOwner) this.#recordCooldown(reservation, now);
    }
    await this.#audit("participation_response", reservation, { outcome: "committed" });
    return true;
  }

  cancel(reservationId) {
    return this.reservations.delete(reservationId);
  }

  async executeAdminCommand(command, { guildId }) {
    if (command.action === "show") return this.formatStatus(guildId);
    if (command.action === "set") {
      const parsedValue = parsePolicyValue(command.path, command.value);
      const next = normalizeParticipationPolicy(nestedSet(this.policy, command.path, parsedValue));
      await this.#persistPolicy(next);
      this.policy = next;
      await this.#audit("participation_config_changed", { guildId }, { path: command.path, value: parsedValue });
      return `Participation setting updated: \`${command.path}\` = \`${parsedValue}\`.`;
    }
    if (command.action === "reset") {
      const next = normalizeParticipationPolicy(DEFAULT_PARTICIPATION_POLICY);
      await this.#persistPolicy(next);
      this.policy = next;
      await this.#audit("participation_config_reset", { guildId }, {});
      return "Participation limits reset to their safe defaults.";
    }
    if (command.action === "unban") {
      if (!command.userId) return "Usage: `@JJ limits unban @user`";
      const removed = await this.#unban(guildId, command.userId);
      return removed
        ? `Temporary JJ block removed for <@${command.userId}>.`
        : `No active JJ block exists for <@${command.userId}> in this server.`;
    }
    throw new Error("Unsupported participation command");
  }

  formatStatus(guildId) {
    const p = this.policy;
    const activeBans = [...this.bans.values()].filter(
      (ban) => (!guildId || ban.guildId === guildId) && ban.expiresAt > this.now(),
    ).length;
    return (
      `**Participation limits** â€” ${p.enabled ? "enabled" : "disabled"}\n` +
      `Budget: ${p.budget.maxResponses} responses / ${p.budget.windowMinutes} min globally\n` +
      `Conversation: ${p.conversation.turns} turns, ${p.conversation.idleMinutes} min idle expiry\n` +
      `Cooldown: ${p.cooldown.baseSeconds}s Ã— ${p.cooldown.multiplier}, max ${p.cooldown.maxSeconds}s\n` +
      `Autoban: ${p.autoban.enabled ? "enabled" : "disabled"}, ${p.autoban.triggers} triggers / ${p.autoban.windowSeconds}s, ${p.autoban.durationMinutes} min first block\n` +
      `Active temporary blocks: ${activeBans}`
    );
  }

  async close() {
    await this.persistence;
  }

  #recordCooldown(reservation, now) {
    const key = this.#userKey(reservation.guildId, reservation.userId);
    const previous = this.cooldowns.get(key);
    const resetMs = this.policy.cooldown.resetMinutes * MINUTE_MS;
    const decayMs = this.policy.cooldown.decaySeconds * 1_000;
    let level = 0;
    if (previous && now - previous.lastResponseAt < resetMs) {
      const decay = Math.floor((now - previous.lastResponseAt) / decayMs);
      level = Math.max(0, previous.level - decay);
    }
    const seconds = Math.min(
      this.policy.cooldown.maxSeconds,
      this.policy.cooldown.baseSeconds * this.policy.cooldown.multiplier ** level,
    );
    this.cooldowns.set(key, { level: level + 1, until: now + seconds * 1_000, lastResponseAt: now });
  }

  async #maybeAutoban(reservation, userKey, now) {
    const policy = this.policy.autoban;
    if (!policy.enabled) return null;
    const attempts = this.spamAttempts.get(userKey) || [];
    const rejected = attempts.filter((item) => item.rejectedByCooldown).length;
    if (attempts.length < policy.triggers || rejected < policy.cooldownRejections) return null;

    const previous = this.offenses.get(userKey);
    const repeated = previous && now - previous.lastAt < policy.repeatWindowHours * HOUR_MS;
    const count = repeated ? previous.count + 1 : 1;
    const baseDuration = count === 1
      ? policy.durationMinutes
      : policy.repeatDurationMinutes * 2 ** Math.max(0, count - 2);
    const durationMinutes = Math.min(policy.maxDurationMinutes, baseDuration);
    const reason = `${attempts.length} explicit triggers in ${policy.windowSeconds}s; ${rejected} rejected by cooldown`;
    const ban = {
      guildId: reservation.guildId,
      userId: reservation.userId,
      username: reservation.username,
      reason,
      createdAt: now,
      expiresAt: now + durationMinutes * MINUTE_MS,
      offenseCount: count,
    };
    this.bans.set(userKey, ban);
    this.offenses.set(userKey, { guildId: reservation.guildId, userId: reservation.userId, count, lastAt: now });
    this.spamAttempts.delete(userKey);
    await this.#persistState();
    await this.#audit("participation_autoban", reservation, { reason, expiresAt: ban.expiresAt, offenseCount: count });
    return ban;
  }

  async #activeBan(key, now) {
    const ban = this.bans.get(key);
    if (!ban) return null;
    if (ban.expiresAt > now) return ban;
    this.bans.delete(key);
    await this.#persistState();
    await this.#audit("participation_autounban", ban, { reason: "expired" });
    return null;
  }

  async #removeExpiredBans(now) {
    let changed = false;
    for (const [key, ban] of this.bans) {
      if (ban.expiresAt <= now) {
        this.bans.delete(key);
        changed = true;
      }
    }
    if (changed) await this.#persistState();
  }

  async #unban(guildId, userId) {
    if (!guildId) return false;
    const key = this.#userKey(guildId, userId);
    const removed = this.bans.delete(key);
    if (removed) {
      await this.#persistState();
      await this.#audit("participation_manual_unban", { guildId, userId }, {});
    }
    return removed;
  }

  async #persistPolicy(policy) {
    this.persistence = this.persistence.then(async () => {
      let root = {};
      try {
        root = JSON.parse(await readFile(this.configPath, "utf8"));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      root.participation = { ...(root.participation || {}), ...policy };
      await atomicJsonWrite(this.configPath, root);
    });
    await this.persistence;
  }

  async #persistState() {
    const payload = { bans: [...this.bans.values()], offenses: [...this.offenses.values()] };
    this.persistence = this.persistence.then(() => atomicJsonWrite(this.statePath, payload));
    await this.persistence;
  }

  async #audit(type, reservation, details) {
    await this.auditLogger?.log({
      type,
      guildId: reservation.guildId || null,
      channelId: reservation.channelId || null,
      userId: reservation.userId || null,
      username: reservation.username || null,
      ...details,
    });
  }

  async #deny(reason, reservation, details) {
    await this.#audit("participation_denied", reservation, { reason, ...details });
    return { allowed: false, reason, ...details };
  }

  #userKey(guildId, userId) {
    return `${guildId}:${userId}`;
  }

  #sessionKey(guildId, channelId, userId) {
    return `${guildId}:${channelId}:${userId}`;
  }
}
