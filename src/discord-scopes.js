import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const ATTENTION_MODES = new Set(["all", "mentions_only", "name_match", "keywords"]);
const SCOPE_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,40}$/;

function cleanString(value) {
  return String(value || "").trim();
}

function cleanList(value, max = 100) {
  const entries = Array.isArray(value) ? value : String(value || "").split(",");
  return [...new Set(entries.map(cleanString).filter(Boolean))].slice(0, max);
}

function cleanBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  if (String(value).toLowerCase() === "true") return true;
  if (String(value).toLowerCase() === "false") return false;
  throw new Error("Boolean scope values must be true or false.");
}

function cleanAttentionMode(value, fallback = "mentions_only") {
  const mode = cleanString(value || fallback).toLowerCase();
  if (!ATTENTION_MODES.has(mode)) {
    throw new Error("attentionMode must be one of: all, mentions_only, name_match, keywords");
  }
  return mode;
}

export function validateScopeName(name) {
  const scope = cleanString(name);
  if (!SCOPE_NAME_PATTERN.test(scope)) {
    throw new Error("scope must be 1-40 characters: letters, numbers, underscore, or dash.");
  }
  return scope;
}

export function normalizeDiscordScope(input = {}, fallback = {}) {
  const scope = {
    label: cleanString(input.label ?? fallback.label),
    guildIds: cleanList(input.guildIds ?? fallback.guildIds),
    channelIds: cleanList(input.channelIds ?? fallback.channelIds),
    defaultChannelId: cleanString(input.defaultChannelId ?? fallback.defaultChannelId),
    allowSend: cleanBoolean(input.allowSend, fallback.allowSend === true),
    allowRelayReply: cleanBoolean(input.allowRelayReply, fallback.allowRelayReply !== false),
    attentionMode: cleanAttentionMode(
      input.attentionMode ?? input.routingMode,
      fallback.attentionMode || fallback.routingMode || "mentions_only",
    ),
    names: cleanList(input.names ?? fallback.names, 25),
    keywords: cleanList(input.keywords ?? fallback.keywords, 50),
    includeRepliesToSelf: cleanBoolean(
      input.includeRepliesToSelf,
      fallback.includeRepliesToSelf !== false,
    ),
  };

  if (!scope.defaultChannelId && scope.channelIds.length === 1) {
    scope.defaultChannelId = scope.channelIds[0];
  }
  if (scope.defaultChannelId && !scope.channelIds.includes(scope.defaultChannelId)) {
    scope.channelIds.unshift(scope.defaultChannelId);
  }
  if (scope.allowSend && !scope.guildIds.length && !scope.channelIds.length) {
    throw new Error("A send-enabled scope must restrict at least one guild or channel.");
  }
  return scope;
}

export function normalizeDiscordScopes(scopes = {}) {
  const normalized = {};
  if (!scopes || typeof scopes !== "object" || Array.isArray(scopes)) return normalized;
  for (const [name, scope] of Object.entries(scopes)) {
    normalized[validateScopeName(name)] = normalizeDiscordScope(scope);
  }
  return normalized;
}

export function listDiscordScopes(scopes = {}) {
  return Object.entries(normalizeDiscordScopes(scopes))
    .map(([name, scope]) => ({ name, ...scope }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function resolveDiscordScope(scopes = {}, name) {
  const scopeName = validateScopeName(name);
  const scope = normalizeDiscordScopes(scopes)[scopeName];
  return scope ? { name: scopeName, ...scope } : null;
}

export function scopeAllowsChannel(scope, { guildId = null, channelId = null, parentId = null } = {}) {
  if (!scope) return false;
  if (scope.guildIds.length && !scope.guildIds.includes(String(guildId || ""))) return false;
  if (!scope.channelIds.length) return true;
  return scope.channelIds.includes(String(channelId || "")) ||
    (Boolean(parentId) && scope.channelIds.includes(String(parentId)));
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

async function readJsonObject(path) {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

export async function setDiscordScope(configPath, scopes, name, patch) {
  const scopeName = validateScopeName(name);
  const currentScopes = normalizeDiscordScopes(scopes);
  const nextScope = normalizeDiscordScope(patch, currentScopes[scopeName] || {});
  const root = await readJsonObject(configPath);
  root.discord = root.discord && typeof root.discord === "object" && !Array.isArray(root.discord)
    ? root.discord
    : {};
  root.discord.scopes = {
    ...normalizeDiscordScopes(root.discord.scopes),
    [scopeName]: nextScope,
  };
  await atomicJsonWrite(configPath, root);
  return { name: scopeName, ...nextScope };
}

export async function clearDiscordScope(configPath, scopes, name) {
  const scopeName = validateScopeName(name);
  const root = await readJsonObject(configPath);
  root.discord = root.discord && typeof root.discord === "object" && !Array.isArray(root.discord)
    ? root.discord
    : {};
  const nextScopes = normalizeDiscordScopes(root.discord.scopes || scopes);
  const removed = Object.hasOwn(nextScopes, scopeName);
  delete nextScopes[scopeName];
  root.discord.scopes = nextScopes;
  await atomicJsonWrite(configPath, root);
  return { removed, name: scopeName };
}
