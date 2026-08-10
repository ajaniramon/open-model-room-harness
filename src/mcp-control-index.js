import { existsSync } from "node:fs";
import { config as loadEnv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AudioModeState } from "./audio-mode.js";
import { BehaviorModeController } from "./behavior-mode.js";
import { ChatRelayQueue } from "./chat-relay.js";
import { normalizeDiscordScopes } from "./discord-scopes.js";
import { loadJsonConfig, setting } from "./config-source.js";
import { MemoryStore } from "./memory-store.js";
import { startMcpControlServer } from "./mcp-control-server.js";
import {
  normalizeParticipationPolicy,
  ParticipationController,
} from "./participation-policy.js";
import { RuntimeControl } from "./runtime-control.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const controlEnvPath = resolve(projectRoot, ".env.control");
loadEnv({
  path: existsSync(controlEnvPath) ? controlEnvPath : resolve(projectRoot, ".env"),
  quiet: true,
});

function boolean(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  if (raw.toLowerCase() === "true") return true;
  if (raw.toLowerCase() === "false") return false;
  throw new Error(`${name} must be true or false`);
}

function integer(name, fallback, { min, max }) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function configured(jsonConfig, path, environmentName, fallback) {
  return setting(jsonConfig, path, environmentName, fallback);
}

function configuredInteger(jsonConfig, path, environmentName, fallback, { min, max }) {
  const value = Number(configured(jsonConfig, path, environmentName, fallback));
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${path} (${environmentName}) must be an integer between ${min} and ${max}`);
  }
  return value;
}

function configuredBoolean(jsonConfig, path, environmentName, fallback) {
  const value = configured(jsonConfig, path, environmentName, fallback);
  if (typeof value === "boolean") return value;
  if (String(value).toLowerCase() === "true") return true;
  if (String(value).toLowerCase() === "false") return false;
  throw new Error(`${path} (${environmentName}) must be true or false`);
}

function configuredList(jsonConfig, path, environmentName, fallback = []) {
  const value = configured(jsonConfig, path, environmentName, fallback);
  const entries = Array.isArray(value) ? value : String(value || "").split(",");
  return entries.map((entry) => String(entry).trim()).filter(Boolean);
}

const configPath = resolve(projectRoot, "config.json");
const jsonConfig = loadJsonConfig(configPath);

const behaviorModeController = await new BehaviorModeController({
  settings: {
    enabled: boolean("BEHAVIOR_MODE_ENABLED", true),
    defaultMode: process.env.BEHAVIOR_MODE_DEFAULT || "manual",
    statePath: resolve(
      projectRoot,
      process.env.BEHAVIOR_MODE_STATE_PATH || "state/behavior-mode.json",
    ),
    auto: {
      cooldownSeconds: integer("BEHAVIOR_MODE_AUTO_COOLDOWN_SECONDS", 180, {
        min: 0,
        max: 86_400,
      }),
      maxRepliesPerHour: integer("BEHAVIOR_MODE_AUTO_MAX_REPLIES_PER_HOUR", 8, {
        min: 0,
        max: 500,
      }),
    },
  },
}).load();
await behaviorModeController.startWatching();

const participationPolicy = normalizeParticipationPolicy({
  enabled: configuredBoolean(jsonConfig, "participation.enabled", "JJ_PARTICIPATION_ENABLED", true),
  budget: {
    maxResponses: configuredInteger(jsonConfig, "participation.budget.maxResponses", "JJ_PARTICIPATION_BUDGET_MAX_RESPONSES", 12, { min: 1, max: 500 }),
    windowMinutes: configuredInteger(jsonConfig, "participation.budget.windowMinutes", "JJ_PARTICIPATION_BUDGET_WINDOW_MINUTES", 10, { min: 1, max: 1_440 }),
  },
  conversation: {
    turns: configuredInteger(jsonConfig, "participation.conversation.turns", "JJ_PARTICIPATION_CONVERSATION_TURNS", 5, { min: 1, max: 20 }),
    idleMinutes: configuredInteger(jsonConfig, "participation.conversation.idleMinutes", "JJ_PARTICIPATION_CONVERSATION_IDLE_MINUTES", 10, { min: 1, max: 1_440 }),
  },
  cooldown: {
    baseSeconds: configuredInteger(jsonConfig, "participation.cooldown.baseSeconds", "JJ_PARTICIPATION_COOLDOWN_BASE_SECONDS", 3, { min: 0, max: 3_600 }),
    multiplier: configuredInteger(jsonConfig, "participation.cooldown.multiplier", "JJ_PARTICIPATION_COOLDOWN_MULTIPLIER", 2, { min: 1, max: 10 }),
    maxSeconds: configuredInteger(jsonConfig, "participation.cooldown.maxSeconds", "JJ_PARTICIPATION_COOLDOWN_MAX_SECONDS", 60, { min: 0, max: 86_400 }),
    decaySeconds: configuredInteger(jsonConfig, "participation.cooldown.decaySeconds", "JJ_PARTICIPATION_COOLDOWN_DECAY_SECONDS", 120, { min: 1, max: 86_400 }),
    resetMinutes: configuredInteger(jsonConfig, "participation.cooldown.resetMinutes", "JJ_PARTICIPATION_COOLDOWN_RESET_MINUTES", 10, { min: 1, max: 1_440 }),
  },
  autoban: {
    enabled: configuredBoolean(jsonConfig, "participation.autoban.enabled", "JJ_PARTICIPATION_AUTOBAN_ENABLED", true),
    triggers: configuredInteger(jsonConfig, "participation.autoban.triggers", "JJ_PARTICIPATION_AUTOBAN_TRIGGERS", 8, { min: 3, max: 100 }),
    windowSeconds: configuredInteger(jsonConfig, "participation.autoban.windowSeconds", "JJ_PARTICIPATION_AUTOBAN_WINDOW_SECONDS", 20, { min: 5, max: 3_600 }),
    cooldownRejections: configuredInteger(jsonConfig, "participation.autoban.cooldownRejections", "JJ_PARTICIPATION_AUTOBAN_COOLDOWN_REJECTIONS", 4, { min: 1, max: 100 }),
    durationMinutes: configuredInteger(jsonConfig, "participation.autoban.durationMinutes", "JJ_PARTICIPATION_AUTOBAN_DURATION_MINUTES", 10, { min: 1, max: 10_080 }),
    repeatWindowHours: configuredInteger(jsonConfig, "participation.autoban.repeatWindowHours", "JJ_PARTICIPATION_AUTOBAN_REPEAT_WINDOW_HOURS", 24, { min: 1, max: 8_760 }),
    repeatDurationMinutes: configuredInteger(jsonConfig, "participation.autoban.repeatDurationMinutes", "JJ_PARTICIPATION_AUTOBAN_REPEAT_DURATION_MINUTES", 60, { min: 1, max: 10_080 }),
    maxDurationMinutes: configuredInteger(jsonConfig, "participation.autoban.maxDurationMinutes", "JJ_PARTICIPATION_AUTOBAN_MAX_DURATION_MINUTES", 360, { min: 1, max: 43_200 }),
  },
});
const participationController = await new ParticipationController({
  policy: participationPolicy,
  configPath,
  statePath: resolve(
    projectRoot,
    String(configured(jsonConfig, "participation.statePath", "JJ_PARTICIPATION_STATE_PATH", "state/participation-state.json")),
  ),
}).load();

const runtimeControl = await new RuntimeControl({
  statePath: resolve(
    projectRoot,
    String(configured(jsonConfig, "runtimeControl.statePath", "JJ_RUNTIME_CONTROL_STATE_PATH", "state/runtime-control.json")),
  ),
  restartEnabled: configuredBoolean(
    jsonConfig,
    "runtimeControl.restartEnabled",
    "JJ_RUNTIME_CONTROL_RESTART_ENABLED",
    false,
  ),
}).load();

const memoryEnabled = configuredBoolean(jsonConfig, "memory.enabled", "JJ_MEMORY_ENABLED", false);
const memoryStore = memoryEnabled
  ? await new MemoryStore({
      path: resolve(
        projectRoot,
        String(configured(jsonConfig, "memory.storePath", "JJ_MEMORY_STORE_PATH", "state/memory.jsonl")),
      ),
      maxRecords: configuredInteger(jsonConfig, "memory.maxRecords", "JJ_MEMORY_MAX_RECORDS", 5_000, {
        min: 10,
        max: 100_000,
      }),
      maxPerUser: configuredInteger(jsonConfig, "memory.maxPerUser", "JJ_MEMORY_MAX_PER_USER", 300, {
        min: 5,
        max: 10_000,
      }),
      retentionDays: configuredInteger(jsonConfig, "memory.retentionDays", "JJ_MEMORY_RETENTION_DAYS", 90, {
        min: 1,
        max: 3_650,
      }),
      maxTextChars: configuredInteger(jsonConfig, "memory.maxTextChars", "JJ_MEMORY_MAX_TEXT_CHARS", 300, {
        min: 40,
        max: 2_000,
      }),
    }).load()
  : null;

const audioModeState = new AudioModeState(resolve(
  projectRoot,
  process.env.JJ_AUDIO_MODE_STATE_PATH?.trim() || "state/audio-mode.json",
));
await audioModeState.load();
const audioConfigured = Boolean(
  process.env.ELEVENLABS_API_KEY?.trim() && process.env.ELEVENLABS_VOICE_ID?.trim(),
);
const chatRelay = new ChatRelayQueue({
  enabled: configuredBoolean(jsonConfig, "chatRelay.enabled", "CHAT_RELAY_ENABLED", false),
  ttlMs: configuredInteger(jsonConfig, "chatRelay.ttlSeconds", "CHAT_RELAY_TTL_SECONDS", 600, {
    min: 5,
    max: 86_400,
  }) * 1_000,
  maxItems: configuredInteger(jsonConfig, "chatRelay.maxItems", "CHAT_RELAY_MAX_ITEMS", 50, {
    min: 1,
    max: 500,
  }),
  maxContextChars: configuredInteger(
    jsonConfig,
    "chatRelay.maxContextChars",
    "CHAT_RELAY_MAX_CONTEXT_CHARS",
    12_000,
    { min: 500, max: 100_000 },
  ),
});

const server = startMcpControlServer({
  config: {
    chatModel: "control-only",
    chatProvider: "none",
    tavilyApiKey: process.env.TAVILY_API_KEY?.trim() || "",
    nanoGptApiKey: process.env.NANOGPT_API_KEY?.trim() || "",
    memoryEnabled,
    memoryExtractionEnabled: configuredBoolean(
      jsonConfig,
      "memory.extraction.enabled",
      "JJ_MEMORY_EXTRACTION_ENABLED",
      false,
    ),
    xPrefetchEnabled: configuredBoolean(jsonConfig, "xPrefetch.enabled", "JJ_X_PREFETCH_ENABLED", true),
    chatRelay: {
      enabled: chatRelay.enabled,
      ttlMs: chatRelay.ttlMs,
      maxItems: chatRelay.maxItems,
      maxContextChars: chatRelay.maxContextChars,
    },
    discordEmojiPalette: configuredList(jsonConfig, "discord.emojiPalette", "DISCORD_EMOJI_PALETTE")
      .map((value) => String(value).replace(/\s+/g, " ").trim())
      .filter((value) => value.length >= 2 && value.length <= 120)
      .slice(0, 8),
    discordScopes: normalizeDiscordScopes(configured(jsonConfig, "discord.scopes", "JJ_DISCORD_SCOPES", {})),
    codexExecutable: process.env.JJ_CODEX_EXECUTABLE?.trim() || "",
    allowedChannelIds: new Set(configuredList(jsonConfig, "discord.allowedChannelIds", "JJ_ALLOWED_CHANNEL_IDS")),
    ownerUserIds: new Set(configuredList(jsonConfig, "permissions.owner.allowedUserIds", "JJ_OWNER_USER_IDS")),
    ownerUsernames: new Set(configuredList(jsonConfig, "permissions.owner.allowedUsernames", "JJ_OWNER_USERNAMES")),
    webAllowedUserIds: new Set(configuredList(jsonConfig, "permissions.web.allowedUserIds", "JJ_WEB_ALLOWED_USER_IDS")),
    webAllowedUsernames: new Set(configuredList(jsonConfig, "permissions.web.allowedUsernames", "JJ_WEB_ALLOWED_USERNAMES")),
    audioAllowedUserIds: new Set(configuredList(jsonConfig, "permissions.audio.allowedUserIds", "JJ_AUDIO_ALLOWED_USER_IDS")),
    audioAllowedUsernames: new Set(configuredList(jsonConfig, "permissions.audio.allowedUsernames", "JJ_AUDIO_ALLOWED_USERNAMES")),
    imageAllowedUserIds: new Set(configuredList(jsonConfig, "permissions.image.allowedUserIds", "JJ_IMAGE_ALLOWED_USER_IDS")),
    imageAllowedUsernames: new Set(configuredList(jsonConfig, "permissions.image.allowedUsernames", "JJ_IMAGE_ALLOWED_USERNAMES")),
    codexAllowedUserIds: new Set(configuredList(jsonConfig, "permissions.codex.allowedUserIds", "JJ_CODEX_ALLOWED_USER_IDS")),
    codexAllowedUsernames: new Set(configuredList(jsonConfig, "permissions.codex.allowedUsernames", "JJ_CODEX_ALLOWED_USERNAMES")),
    mcpControl: {
      enabled: true,
      host: process.env.MCP_CONTROL_HOST || "127.0.0.1",
      port: integer("MCP_CONTROL_PORT", 3000, { min: 1, max: 65_535 }),
      bearerToken: process.env.MCP_CONTROL_BEARER_TOKEN || "",
    },
  },
  behaviorModeController,
  runtimeControl,
  participationController,
  memoryStore,
  audioModeState,
  audioConfigured,
  chatRelay,
});

let shuttingDown = false;
const shutdown = async (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.info(`Received ${signal}; closing MCP control server.`);
  await server?.close();
  await behaviorModeController.close();
  await participationController.close();
  await memoryStore?.close();
  await runtimeControl.close();
  process.exit(0);
};

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
