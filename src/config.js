import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { DEFAULT_BEHAVIOR_MODE_SETTINGS } from "./behavior-mode.js";
import { normalizeDiscordScopes } from "./discord-scopes.js";
import { loadJsonConfig, setting } from "./config-source.js";
import { resolveTimeZone } from "./message-time.js";
import { normalizeParticipationPolicy } from "./participation-policy.js";
import {
  DEFAULT_LOCAL_BASE_URL,
  openAiCompatibleChatUrl,
} from "./openai-compatible.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
loadEnv({ path: resolve(projectRoot, ".env"), quiet: true });
const configPath = resolve(projectRoot, "config.json");
const jsonConfig = loadJsonConfig(configPath);

function configured(path, environmentName, fallback) {
  return setting(jsonConfig, path, environmentName, fallback);
}

function configuredInteger(path, environmentName, fallback, { min, max }) {
  const value = Number(configured(path, environmentName, fallback));
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${path} (${environmentName}) must be an integer between ${min} and ${max}`);
  }
  return value;
}

function configuredBoolean(path, environmentName, fallback) {
  const value = configured(path, environmentName, fallback);
  if (typeof value === "boolean") return value;
  if (String(value).toLowerCase() === "true") return true;
  if (String(value).toLowerCase() === "false") return false;
  throw new Error(`${path} (${environmentName}) must be true or false`);
}

function configuredList(path, environmentName, fallback = []) {
  const value = configured(path, environmentName, fallback);
  const entries = Array.isArray(value) ? value : String(value || "").split(",");
  return entries.map((entry) => String(entry).trim()).filter(Boolean);
}

function integer(name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function enabled(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  if (raw.toLowerCase() === "true") return true;
  if (raw.toLowerCase() === "false") return false;
  throw new Error(`${name} must be either 'true' or 'false'`);
}

const triggerMode = process.env.JJ_TRIGGER_MODE?.trim().toLowerCase() || "mention";
if (!new Set(["mention", "all"]).has(triggerMode)) {
  throw new Error("JJ_TRIGGER_MODE must be either 'mention' or 'all'");
}
const timeZone = resolveTimeZone(process.env.JJ_TIME_ZONE);
const chatProvider = process.env.MODEL_PROVIDER?.trim().toLowerCase() || "nanogpt";
if (!new Set(["none", "nanogpt", "openai", "anthropic", "xai", "gemini", "local"]).has(chatProvider)) {
  throw new Error("MODEL_PROVIDER must be one of: none, nanogpt, openai, anthropic, xai, gemini, local");
}
// Opt-in fallback for the default conversation route: when the primary inference
// call fails after its retry, the turn is repeated once on this route instead of
// surfacing an error message in Discord. Empty means disabled.
const chatFallbackProvider = process.env.MODEL_FALLBACK_PROVIDER?.trim().toLowerCase() || "";
if (
  chatFallbackProvider &&
  !new Set(["nanogpt", "openai", "anthropic", "xai", "gemini", "local"]).has(chatFallbackProvider)
) {
  throw new Error(
    "MODEL_FALLBACK_PROVIDER must be one of: nanogpt, openai, anthropic, xai, gemini, local",
  );
}

const memoryCaptureMode = String(
  configured("memory.extraction.captureMode", "JJ_MEMORY_CAPTURE_MODE", "observation"),
).toLowerCase();
if (!new Set(["observation", "always"]).has(memoryCaptureMode)) {
  throw new Error("memory.extraction.captureMode (JJ_MEMORY_CAPTURE_MODE) must be 'observation' or 'always'");
}

const spontaneousMinMessages = integer("JJ_SPONTANEOUS_MIN_MESSAGES", 8, { min: 2, max: 100 });
const spontaneousMaxMessages = integer("JJ_SPONTANEOUS_MAX_MESSAGES", 24, { min: 2, max: 200 });
if (spontaneousMaxMessages < spontaneousMinMessages) {
  throw new Error("JJ_SPONTANEOUS_MAX_MESSAGES must be at least JJ_SPONTANEOUS_MIN_MESSAGES");
}
const spontaneousParticipationEnabled = enabled("JJ_SPONTANEOUS_ENABLED", true);

const behaviorModeEnabled = configuredBoolean(
  "behaviorMode.enabled",
  "BEHAVIOR_MODE_ENABLED",
  DEFAULT_BEHAVIOR_MODE_SETTINGS.enabled,
);
const behaviorModeDefault = String(
  configured(
    "behaviorMode.defaultMode",
    "BEHAVIOR_MODE_DEFAULT",
    DEFAULT_BEHAVIOR_MODE_SETTINGS.defaultMode,
  ),
)
  .trim()
  .toLowerCase();
const unifiedBehaviorModeDefault = behaviorModeEnabled
  ? behaviorModeDefault
  : spontaneousParticipationEnabled
    ? "auto"
    : "manual";
const behaviorModeAutoCooldownSeconds = configuredInteger(
  "behaviorMode.auto.cooldownSeconds",
  "BEHAVIOR_MODE_AUTO_COOLDOWN_SECONDS",
  DEFAULT_BEHAVIOR_MODE_SETTINGS.auto.cooldownSeconds,
  { min: 0, max: 86_400 },
);
const behaviorModeAutoMaxRepliesPerHour = configuredInteger(
  "behaviorMode.auto.maxRepliesPerHour",
  "BEHAVIOR_MODE_AUTO_MAX_REPLIES_PER_HOUR",
  DEFAULT_BEHAVIOR_MODE_SETTINGS.auto.maxRepliesPerHour,
  { min: 0, max: 500 },
);
const mcpControlEnabled = configuredBoolean("mcpControl.enabled", "MCP_CONTROL_ENABLED", false);

const participationPolicy = normalizeParticipationPolicy({
  enabled: configuredBoolean("participation.enabled", "JJ_PARTICIPATION_ENABLED", true),
  budget: {
    maxResponses: configuredInteger("participation.budget.maxResponses", "JJ_PARTICIPATION_BUDGET_MAX_RESPONSES", 12, { min: 1, max: 500 }),
    windowMinutes: configuredInteger("participation.budget.windowMinutes", "JJ_PARTICIPATION_BUDGET_WINDOW_MINUTES", 10, { min: 1, max: 1_440 }),
  },
  conversation: {
    turns: configuredInteger("participation.conversation.turns", "JJ_PARTICIPATION_CONVERSATION_TURNS", 5, { min: 1, max: 20 }),
    idleMinutes: configuredInteger("participation.conversation.idleMinutes", "JJ_PARTICIPATION_CONVERSATION_IDLE_MINUTES", 10, { min: 1, max: 1_440 }),
  },
  cooldown: {
    baseSeconds: configuredInteger("participation.cooldown.baseSeconds", "JJ_PARTICIPATION_COOLDOWN_BASE_SECONDS", 3, { min: 0, max: 3_600 }),
    multiplier: configuredInteger("participation.cooldown.multiplier", "JJ_PARTICIPATION_COOLDOWN_MULTIPLIER", 2, { min: 1, max: 10 }),
    maxSeconds: configuredInteger("participation.cooldown.maxSeconds", "JJ_PARTICIPATION_COOLDOWN_MAX_SECONDS", 60, { min: 0, max: 86_400 }),
    decaySeconds: configuredInteger("participation.cooldown.decaySeconds", "JJ_PARTICIPATION_COOLDOWN_DECAY_SECONDS", 120, { min: 1, max: 86_400 }),
    resetMinutes: configuredInteger("participation.cooldown.resetMinutes", "JJ_PARTICIPATION_COOLDOWN_RESET_MINUTES", 10, { min: 1, max: 1_440 }),
  },
  autoban: {
    enabled: configuredBoolean("participation.autoban.enabled", "JJ_PARTICIPATION_AUTOBAN_ENABLED", true),
    triggers: configuredInteger("participation.autoban.triggers", "JJ_PARTICIPATION_AUTOBAN_TRIGGERS", 8, { min: 3, max: 100 }),
    windowSeconds: configuredInteger("participation.autoban.windowSeconds", "JJ_PARTICIPATION_AUTOBAN_WINDOW_SECONDS", 20, { min: 5, max: 3_600 }),
    cooldownRejections: configuredInteger("participation.autoban.cooldownRejections", "JJ_PARTICIPATION_AUTOBAN_COOLDOWN_REJECTIONS", 4, { min: 1, max: 100 }),
    durationMinutes: configuredInteger("participation.autoban.durationMinutes", "JJ_PARTICIPATION_AUTOBAN_DURATION_MINUTES", 10, { min: 1, max: 10_080 }),
    repeatWindowHours: configuredInteger("participation.autoban.repeatWindowHours", "JJ_PARTICIPATION_AUTOBAN_REPEAT_WINDOW_HOURS", 24, { min: 1, max: 8_760 }),
    repeatDurationMinutes: configuredInteger("participation.autoban.repeatDurationMinutes", "JJ_PARTICIPATION_AUTOBAN_REPEAT_DURATION_MINUTES", 60, { min: 1, max: 10_080 }),
    maxDurationMinutes: configuredInteger("participation.autoban.maxDurationMinutes", "JJ_PARTICIPATION_AUTOBAN_MAX_DURATION_MINUTES", 360, { min: 1, max: 43_200 }),
  },
});

const subscriptionEndpoint = "https://nano-gpt.com/api/subscription/v1/chat/completions";
const paidEndpoint = "https://nano-gpt.com/api/v1/chat/completions";
const modelProviders = Object.freeze({
  none: Object.freeze({
    apiKey: "",
    model: "none",
    baseUrl: "",
  }),
  nanogpt: Object.freeze({
    apiKey: process.env.NANOGPT_API_KEY?.trim() || "",
    model: process.env.NANOGPT_MODEL?.trim() || "xiaomi/mimo-v2.5-pro:thinking",
    baseUrl:
      process.env.NANOGPT_BASE_URL?.trim() ||
      "https://nano-gpt.com/api/subscription/v1/chat/completions",
  }),
  openai: Object.freeze({
    apiKey: process.env.OPENAI_API_KEY?.trim() || "",
    model: process.env.OPENAI_MODEL?.trim() || "gpt-5.6-terra",
    baseUrl:
      process.env.OPENAI_BASE_URL?.trim() ||
      "https://api.openai.com/v1/chat/completions",
  }),
  anthropic: Object.freeze({
    apiKey: process.env.ANTHROPIC_API_KEY?.trim() || "",
    model: process.env.ANTHROPIC_MODEL?.trim() || "claude-sonnet-5",
    baseUrl:
      process.env.ANTHROPIC_BASE_URL?.trim() ||
      "https://api.anthropic.com/v1/messages",
  }),
  xai: Object.freeze({
    apiKey: process.env.XAI_API_KEY?.trim() || "",
    model: process.env.XAI_MODEL?.trim() || "grok-4.5",
    baseUrl:
      process.env.XAI_BASE_URL?.trim() ||
      "https://api.x.ai/v1/chat/completions",
  }),
  gemini: Object.freeze({
    apiKey: process.env.GEMINI_API_KEY?.trim() || "",
    model: process.env.GEMINI_MODEL?.trim() || "gemini-3.6-flash",
    baseUrl:
      process.env.GEMINI_BASE_URL?.trim() ||
      "https://generativelanguage.googleapis.com/v1beta",
  }),
  local: Object.freeze({
    apiKey: process.env.LOCAL_API_KEY?.trim() || "",
    model: process.env.LOCAL_MODEL?.trim() || "local-model",
    baseUrl: openAiCompatibleChatUrl(
      process.env.LOCAL_BASE_URL?.trim() || DEFAULT_LOCAL_BASE_URL,
    ),
  }),
});
const providerApiKeyEnv = Object.freeze({
  none: null,
  nanogpt: "NANOGPT_API_KEY",
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  xai: "XAI_API_KEY",
  gemini: "GEMINI_API_KEY",
  local: null,
});
const defaultCodexExecutable =
  process.platform === "win32"
    ? resolve(
        process.env.APPDATA || "",
        "npm",
        "node_modules",
        "@openai",
        "codex",
        "node_modules",
        "@openai",
        "codex-win32-x64",
        "vendor",
        "x86_64-pc-windows-msvc",
        "bin",
        "codex.exe",
      )
    : "codex";
const mimoProRoute = Object.freeze({
  provider: "nanogpt",
  model: "xiaomi/mimo-v2.5-pro:thinking",
  baseUrl: subscriptionEndpoint,
  reasoningEffort: "high",
  billing: "subscription",
});
const opus5Route = Object.freeze({
  provider: "nanogpt",
  model: "anthropic/claude-opus-5",
  baseUrl: paidEndpoint,
  reasoningEffort: "high",
  billing: "paid",
});
const gpt4oNovemberRoute = Object.freeze({
  provider: "nanogpt",
  model: "openai/gpt-4o-2024-11-20",
  baseUrl: paidEndpoint,
  reasoningEffort: "none",
  billing: "paid",
});
const kimiK3Route = Object.freeze({
  provider: "nanogpt",
  model: "moonshotai/kimi-k3",
  baseUrl: paidEndpoint,
  reasoningEffort: "high",
  billing: "paid",
});
const grok45Route = Object.freeze({
  provider: "nanogpt",
  model: "x-ai/grok-4.5",
  baseUrl: paidEndpoint,
  reasoningEffort: "high",
  billing: "paid",
});
const escalationModels = Object.freeze({
  "mimo-pro": mimoProRoute,
  "mimo pro": mimoProRoute,
  mimo: mimoProRoute,
  "xiaomi/mimo-v2.5-pro:thinking": mimoProRoute,
  "opus-5": opus5Route,
  "opus 5": opus5Route,
  "claude opus 5": opus5Route,
  "claude-opus-5": opus5Route,
  "anthropic/claude-opus-5": opus5Route,
  "gpt-4o-nov": gpt4oNovemberRoute,
  "gpt 4o nov": gpt4oNovemberRoute,
  "gpt-4o-2024-11-20": gpt4oNovemberRoute,
  "openai/gpt-4o-2024-11-20": gpt4oNovemberRoute,
  "kimi-k3": kimiK3Route,
  "kimi k3": kimiK3Route,
  k3: kimiK3Route,
  "moonshot/kimi-k3": kimiK3Route,
  "moonshotai/kimi-k3": kimiK3Route,
  "grok-4.5": grok45Route,
  "grok 4.5": grok45Route,
  grok45: grok45Route,
  "x-ai/grok-4.5": grok45Route,
});

export const config = Object.freeze({
  projectRoot,
  configPath,
  discordToken: process.env.DISCORD_TOKEN?.trim() || "",
  nanoGptApiKey: process.env.NANOGPT_API_KEY?.trim() || "",
  tavilyApiKey: process.env.TAVILY_API_KEY?.trim() || "",
  chatProvider,
  chatApiKey: modelProviders[chatProvider].apiKey,
  chatApiKeyEnv: providerApiKeyEnv[chatProvider],
  chatModel: modelProviders[chatProvider].model,
  chatBaseUrl: modelProviders[chatProvider].baseUrl,
  chatFallbackProvider,
  chatFallbackModel: process.env.MODEL_FALLBACK_MODEL?.trim() || "",
  chatFallbackBaseUrl: process.env.MODEL_FALLBACK_BASE_URL?.trim() || "",
  // Circuit breaker: after this many consecutive transport failures a route is
  // skipped for the cooldown window, so a dead primary jumps straight to fallback.
  breakerThreshold: integer("MODEL_BREAKER_THRESHOLD", 3, { min: 1, max: 100 }),
  breakerCooldownMs:
    integer("MODEL_BREAKER_COOLDOWN_SECONDS", 30, { min: 1, max: 3_600 }) * 1_000,
  modelProviders,
  nanoGptModel:
    process.env.NANOGPT_MODEL?.trim() ||
    "xiaomi/mimo-v2.5-pro:thinking",
  nanoGptBaseUrl:
    process.env.NANOGPT_BASE_URL?.trim() ||
    "https://nano-gpt.com/api/subscription/v1/chat/completions",
  triggerMode,
  allowedChannelIds: new Set(
    configuredList("discord.allowedChannelIds", "JJ_ALLOWED_CHANNEL_IDS"),
  ),
  discordEmojiPalette: Object.freeze(
    configuredList("discord.emojiPalette", "DISCORD_EMOJI_PALETTE")
      .map((value) => String(value).replace(/\s+/g, " ").trim())
      .filter((value) => value.length >= 2 && value.length <= 120)
      .slice(0, 8),
  ),
  discordScopes: normalizeDiscordScopes(configured("discord.scopes", "JJ_DISCORD_SCOPES", {})),
  blockedUsernames: new Set(
    (process.env.JJ_BLOCKED_USERNAMES || "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  ),
  webAllowedUserIds: new Set(
    (process.env.JJ_WEB_ALLOWED_USER_IDS || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  ),
  webAllowedUsernames: new Set(
    (process.env.JJ_WEB_ALLOWED_USERNAMES || "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  ),
  audioAllowedUserIds: new Set(
    (process.env.JJ_AUDIO_ALLOWED_USER_IDS || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  ),
  audioAllowedUsernames: new Set(
    (process.env.JJ_AUDIO_ALLOWED_USERNAMES || "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  ),
  audioModeStatePath: resolve(
    projectRoot,
    process.env.JJ_AUDIO_MODE_STATE_PATH?.trim() || "state/audio-mode.json",
  ),
  elevenLabsApiKey: process.env.ELEVENLABS_API_KEY?.trim() || "",
  elevenLabsVoiceId:
    process.env.ELEVENLABS_VOICE_ID?.trim() || "21m00Tcm4TlvDq8ikWAM",
  elevenLabsModelId: process.env.ELEVENLABS_MODEL_ID?.trim() || "eleven_v3",
  elevenLabsOutputFormat:
    process.env.ELEVENLABS_OUTPUT_FORMAT?.trim() || "mp3_44100_128",
  elevenLabsTimeoutMs: integer("ELEVENLABS_TIMEOUT_MS", 60_000, {
    min: 5_000,
    max: 180_000,
  }),
  audioMaxChars: integer("JJ_AUDIO_MAX_CHARS", 1_200, {
    min: 100,
    max: 5_000,
  }),
  audioMaxBytes: integer("JJ_AUDIO_MAX_BYTES", 8_000_000, {
    min: 100_000,
    max: 25_000_000,
  }),
  imageAllowedUserIds: new Set(
    (process.env.JJ_IMAGE_ALLOWED_USER_IDS || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  ),
  imageAllowedUsernames: new Set(
    (process.env.JJ_IMAGE_ALLOWED_USERNAMES || "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  ),
  imageApiBaseUrl:
    process.env.NANOGPT_IMAGE_BASE_URL?.trim() || "https://nano-gpt.com/api/v1",
  imageDefaultModel:
    process.env.NANOGPT_IMAGE_MODEL?.trim() || "gpt-image-2",
  imagePromptModel:
    process.env.NANOGPT_IMAGE_PROMPT_MODEL?.trim() || "qwen3.7-flash:thinking",
  imagePromptBaseUrl:
    process.env.NANOGPT_IMAGE_PROMPT_BASE_URL?.trim() ||
    "https://nano-gpt.com/api/v1/chat/completions",
  imageTimeoutMs: integer("NANOGPT_IMAGE_TIMEOUT_MS", 180_000, {
    min: 10_000,
    max: 600_000,
  }),
  imageMaxPromptChars: integer("JJ_IMAGE_MAX_PROMPT_CHARS", 3_000, {
    min: 100,
    max: 20_000,
  }),
  imageMaxBytes: integer("JJ_IMAGE_MAX_BYTES", 10_000_000, {
    min: 100_000,
    max: 25_000_000,
  }),
  visionModel:
    process.env.NANOGPT_VISION_MODEL?.trim() || "qwen3.7-flash:thinking",
  visionBaseUrl:
    process.env.NANOGPT_VISION_BASE_URL?.trim() ||
    "https://nano-gpt.com/api/v1/chat/completions",
  visionTimeoutMs: integer("NANOGPT_VISION_TIMEOUT_MS", 90_000, {
    min: 5_000,
    max: 300_000,
  }),
  visionMaxImages: integer("JJ_VISION_MAX_IMAGES", 4, { min: 1, max: 10 }),
  visionMaxBytes: integer("JJ_VISION_MAX_BYTES", 8_000_000, {
    min: 100_000,
    max: 25_000_000,
  }),
  visionMaxOutputTokens: integer("JJ_VISION_MAX_OUTPUT_TOKENS", 1_200, {
    min: 128,
    max: 8_192,
  }),
  xPrefetchEnabled: configuredBoolean("xPrefetch.enabled", "JJ_X_PREFETCH_ENABLED", true),
  xPrefetchMaxPosts: configuredInteger("xPrefetch.maxPosts", "JJ_X_PREFETCH_MAX_POSTS", 2, {
    min: 1,
    max: 5,
  }),
  xPrefetchMaxChars: configuredInteger("xPrefetch.maxChars", "JJ_X_PREFETCH_MAX_CHARS", 1_200, {
    min: 200,
    max: 10_000,
  }),
  webPrefetchEnabled: configuredBoolean("webPrefetch.enabled", "JJ_WEB_PREFETCH_ENABLED", true),
  webPrefetchMaxUrls: configuredInteger("webPrefetch.maxUrls", "JJ_WEB_PREFETCH_MAX_URLS", 2, {
    min: 1,
    max: 5,
  }),
  webPrefetchMaxChars: configuredInteger("webPrefetch.maxChars", "JJ_WEB_PREFETCH_MAX_CHARS", 3_000, {
    min: 500,
    max: 20_000,
  }),
  codexAllowedUserIds: new Set(
    (process.env.JJ_CODEX_ALLOWED_USER_IDS || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  ),
  codexAllowedUsernames: new Set(
    (process.env.JJ_CODEX_ALLOWED_USERNAMES || "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  ),
  codexExecutable:
    process.env.JJ_CODEX_EXECUTABLE?.trim() ||
    (existsSync(defaultCodexExecutable) ? defaultCodexExecutable : "codex"),
  codexWorkspace: resolve(projectRoot, process.env.JJ_CODEX_WORKSPACE?.trim() || "codex-workspace"),
  codexProjectWorkspace: projectRoot,
  codexYoloEnabled: enabled("JJ_CODEX_YOLO_ENABLED"),
  codexYoloWorkspace: process.env.JJ_CODEX_YOLO_WORKSPACE?.trim()
    ? resolve(projectRoot, process.env.JJ_CODEX_YOLO_WORKSPACE.trim())
    : null,
  codexTimeoutMs: integer("JJ_CODEX_TIMEOUT_MS", 600_000, {
    min: 30_000,
    max: 3_600_000,
  }),
  codexMaxTaskChars: integer("JJ_CODEX_MAX_TASK_CHARS", 8_000, {
    min: 100,
    max: 50_000,
  }),
  codexMaxResultChars: integer("JJ_CODEX_MAX_RESULT_CHARS", 30_000, {
    min: 1_000,
    max: 100_000,
  }),
  escalationAllowedUserIds: new Set(
    (process.env.JJ_ESCALATION_ALLOWED_USER_IDS || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  ),
  escalationAllowedUsernames: new Set(
    (process.env.JJ_ESCALATION_ALLOWED_USERNAMES || "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  ),
  ownerUserIds: new Set(
    configuredList(
      "permissions.owner.allowedUserIds",
      "JJ_OWNER_USER_IDS",
      process.env.JJ_CODEX_ALLOWED_USER_IDS || process.env.JJ_WEB_ALLOWED_USER_IDS || "",
    ),
  ),
  ownerUsernames: new Set(
    configuredList(
      "permissions.owner.allowedUsernames",
      "JJ_OWNER_USERNAMES",
      process.env.JJ_CODEX_ALLOWED_USERNAMES || process.env.JJ_WEB_ALLOWED_USERNAMES || "",
    ).map((value) => value.toLowerCase()),
  ),
  escalationModels,
  escalationMaxOutputTokens: integer("JJ_ESCALATION_MAX_OUTPUT_TOKENS", 12_000, {
    min: 128,
    max: 32_768,
  }),
  respondToBots: enabled("JJ_RESPOND_TO_BOTS"),
  contextMessages: integer("JJ_CONTEXT_MESSAGES", 24, { min: 1, max: 75 }),
  contextTimestamps: enabled("JJ_CONTEXT_TIMESTAMPS", true),
  timeZone,
  maxOutputTokens: integer("JJ_MAX_OUTPUT_TOKENS", 4096, { min: 64, max: 8192 }),
  reasoningEffort: process.env.JJ_REASONING_EFFORT?.trim() || "high",
  apiTimeoutMs: integer("JJ_API_TIMEOUT_MS", 120_000, { min: 5_000, max: 300_000 }),
  maxToolIterations: integer("JJ_MAX_TOOL_ITERATIONS", 4, { min: 1, max: 8 }),
  participationPolicy: Object.freeze(participationPolicy),
  participationStatePath: resolve(
    projectRoot,
    String(configured("participation.statePath", "JJ_PARTICIPATION_STATE_PATH", "state/participation-state.json")),
  ),
  participationAudit: Object.freeze({
    enabled: configuredBoolean("logging.participation.enabled", "JJ_PARTICIPATION_AUDIT_ENABLED", true),
    path: resolve(
      projectRoot,
      String(configured("logging.participation.path", "JJ_PARTICIPATION_AUDIT_PATH", "logs/participation-events.jsonl")),
    ),
    maxBytes: configuredInteger("logging.participation.maxBytes", "JJ_PARTICIPATION_AUDIT_MAX_BYTES", 5 * 1024 * 1024, { min: 1_024, max: 1024 * 1024 * 1024 }),
    maxArchives: configuredInteger("logging.participation.maxArchives", "JJ_PARTICIPATION_AUDIT_MAX_ARCHIVES", 5, { min: 1, max: 100 }),
    includeBodies: false,
    maxValueChars: 10_000,
  }),
  behaviorMode: Object.freeze({
    // Runtime control, scoped behavior and memory capture now share this one policy.
    // Legacy deployments map their spontaneous setting to auto/manual by default.
    enabled: true,
    defaultMode: unifiedBehaviorModeDefault,
    statePath: resolve(
      projectRoot,
      String(
        configured(
          "behaviorMode.statePath",
          "BEHAVIOR_MODE_STATE_PATH",
          DEFAULT_BEHAVIOR_MODE_SETTINGS.statePath,
        ),
      ),
    ),
    auto: Object.freeze({
      cooldownSeconds: behaviorModeAutoCooldownSeconds,
      maxRepliesPerHour: behaviorModeAutoMaxRepliesPerHour,
    }),
  }),
  mcpControl: Object.freeze({
    enabled: mcpControlEnabled,
    host: String(configured("mcpControl.host", "MCP_CONTROL_HOST", "127.0.0.1")),
    port: configuredInteger("mcpControl.port", "MCP_CONTROL_PORT", 3000, {
      min: 1,
      max: 65_535,
    }),
    bearerToken: String(configured("mcpControl.bearerToken", "MCP_CONTROL_BEARER_TOKEN", "")),
    wakeToken: String(configured("mcpControl.wakeToken", "MCP_CONTROL_WAKE_TOKEN", "")),
  }),
  chatRelay: Object.freeze({
    enabled: configuredBoolean("chatRelay.enabled", "CHAT_RELAY_ENABLED", false),
    statePath: resolve(
      projectRoot,
      String(configured("chatRelay.statePath", "CHAT_RELAY_STATE_PATH", "state/chat-relay.json")),
    ),
    ttlMs: configuredInteger("chatRelay.ttlSeconds", "CHAT_RELAY_TTL_SECONDS", 600, {
      min: 5,
      max: 86_400,
    }) * 1_000,
    maxItems: configuredInteger("chatRelay.maxItems", "CHAT_RELAY_MAX_ITEMS", 50, {
      min: 1,
      max: 500,
    }),
    maxContextChars: configuredInteger(
      "chatRelay.maxContextChars",
      "CHAT_RELAY_MAX_CONTEXT_CHARS",
      12_000,
      { min: 500, max: 100_000 },
    ),
    leaseSeconds: configuredInteger("chatRelay.leaseSeconds", "CHAT_RELAY_LEASE_SECONDS", 120, {
      min: 10,
      max: 3_600,
    }),
    maxAttempts: configuredInteger("chatRelay.maxAttempts", "CHAT_RELAY_MAX_ATTEMPTS", 3, {
      min: 1,
      max: 20,
    }),
    maxImageAttachments: configuredInteger(
      "chatRelay.maxImageAttachments",
      "CHAT_RELAY_MAX_IMAGE_ATTACHMENTS",
      4,
      { min: 0, max: 10 },
    ),
    maxAttachmentBytes: configuredInteger(
      "chatRelay.maxAttachmentBytes",
      "CHAT_RELAY_MAX_ATTACHMENT_BYTES",
      8_000_000,
      { min: 1_024, max: 20_000_000 },
    ),
  }),
  discordWatchdog: Object.freeze({
    enabled: configuredBoolean("discord.watchdog.enabled", "DISCORD_WATCHDOG_ENABLED", false),
    graceMs: configuredInteger(
      "discord.watchdog.graceSeconds",
      "DISCORD_WATCHDOG_GRACE_SECONDS",
      90,
      { min: 10, max: 3_600 },
    ) * 1_000,
    checkIntervalMs: configuredInteger(
      "discord.watchdog.checkIntervalSeconds",
      "DISCORD_WATCHDOG_CHECK_INTERVAL_SECONDS",
      15,
      { min: 5, max: 300 },
    ) * 1_000,
  }),
  // Memory is OFF by default. It stores content from a shared room, so an operator
  // has to switch it on deliberately and take on the obligations in README §Memory.
  memoryEnabled: configuredBoolean("memory.enabled", "JJ_MEMORY_ENABLED", false),
  memoryAllowedUserIds: new Set(
    configuredList("permissions.memory.allowedUserIds", "JJ_MEMORY_ALLOWED_USER_IDS").map(String),
  ),
  memoryAllowedUsernames: new Set(
    configuredList("permissions.memory.allowedUsernames", "JJ_MEMORY_ALLOWED_USERNAMES").map(
      (value) => String(value).toLowerCase(),
    ),
  ),
  memoryStorePath: resolve(
    projectRoot,
    String(configured("memory.storePath", "JJ_MEMORY_STORE_PATH", "state/memory.jsonl")),
  ),
  memoryMaxRecords: configuredInteger("memory.maxRecords", "JJ_MEMORY_MAX_RECORDS", 5_000, {
    min: 10,
    max: 100_000,
  }),
  memoryMaxPerUser: configuredInteger("memory.maxPerUser", "JJ_MEMORY_MAX_PER_USER", 300, {
    min: 5,
    max: 10_000,
  }),
  memoryRetentionDays: configuredInteger("memory.retentionDays", "JJ_MEMORY_RETENTION_DAYS", 90, {
    min: 1,
    max: 3_650,
  }),
  // How often the retention window is actually swept on a long-running host, so
  // expired notes are deleted from disk instead of only being hidden at read time.
  memoryRetentionSweepHours: configuredInteger(
    "memory.retentionSweepHours",
    "JJ_MEMORY_RETENTION_SWEEP_HOURS",
    6,
    { min: 1, max: 168 },
  ),
  memoryMaxTextChars: configuredInteger("memory.maxTextChars", "JJ_MEMORY_MAX_TEXT_CHARS", 300, {
    min: 40,
    max: 2_000,
  }),
  memoryInjectionMaxItems: configuredInteger(
    "memory.injection.maxItems",
    "JJ_MEMORY_INJECTION_MAX_ITEMS",
    40,
    { min: 1, max: 2_000 },
  ),
  memoryInjectionMaxChars: configuredInteger(
    "memory.injection.maxChars",
    "JJ_MEMORY_INJECTION_MAX_CHARS",
    6_000,
    // The upper bound is deliberately conservative: the stable core is injected on
    // every request, so a fat-fingered value here is billed on every turn.
    { min: 100, max: 60_000 },
  ),
  memoryInjectionPerSubjectMaxItems: configuredInteger(
    "memory.injection.perSubjectMaxItems",
    "JJ_MEMORY_INJECTION_PER_SUBJECT_MAX_ITEMS",
    6,
    { min: 1, max: 200 },
  ),
  memoryFocusMaxItems: configuredInteger(
    "memory.injection.focus.maxItems",
    "JJ_MEMORY_FOCUS_MAX_ITEMS",
    6,
    { min: 0, max: 50 },
  ),
  memoryFocusMaxChars: configuredInteger(
    "memory.injection.focus.maxChars",
    "JJ_MEMORY_FOCUS_MAX_CHARS",
    1_500,
    { min: 0, max: 20_000 },
  ),
  // Passive capture is a second, separate switch: enabling memory alone only gives
  // the explicit "remember this" commands.
  memoryExtractionEnabled: configuredBoolean(
    "memory.extraction.enabled",
    "JJ_MEMORY_EXTRACTION_ENABLED",
    false,
  ),
  memoryExtractionCaptureMode: memoryCaptureMode,
  memoryExtractionProvider: String(
    configured("memory.extraction.provider", "JJ_MEMORY_EXTRACTION_PROVIDER", "") || chatProvider,
  ).toLowerCase(),
  memoryExtractionModel: String(
    configured("memory.extraction.model", "JJ_MEMORY_EXTRACTION_MODEL", "") || "",
  ),
  memoryExtractionBaseUrl: String(
    configured("memory.extraction.baseUrl", "JJ_MEMORY_EXTRACTION_BASE_URL", "") || "",
  ),
  memoryExtractionIdleMs:
    configuredInteger("memory.extraction.idleMinutes", "JJ_MEMORY_EXTRACTION_IDLE_MINUTES", 10, {
      min: 1,
      max: 1_440,
    }) * 60_000,
  memoryExtractionMinMessages: configuredInteger(
    "memory.extraction.minMessages",
    "JJ_MEMORY_EXTRACTION_MIN_MESSAGES",
    4,
    { min: 1, max: 200 },
  ),
  memoryExtractionMaxMessages: configuredInteger(
    "memory.extraction.maxMessages",
    "JJ_MEMORY_EXTRACTION_MAX_MESSAGES",
    40,
    { min: 2, max: 500 },
  ),
  memoryExtractionMaxChars: configuredInteger(
    "memory.extraction.maxTranscriptChars",
    "JJ_MEMORY_EXTRACTION_MAX_CHARS",
    8_000,
    { min: 200, max: 100_000 },
  ),
  memoryExtractionMaxFacts: configuredInteger(
    "memory.extraction.maxFacts",
    "JJ_MEMORY_EXTRACTION_MAX_FACTS",
    5,
    { min: 1, max: 20 },
  ),
  memoryExtractionMaxOutputTokens: configuredInteger(
    "memory.extraction.maxOutputTokens",
    "JJ_MEMORY_EXTRACTION_MAX_OUTPUT_TOKENS",
    800,
    { min: 128, max: 8_192 },
  ),
  memoryExtractionCheckIntervalMs:
    configuredInteger(
      "memory.extraction.checkIntervalSeconds",
      "JJ_MEMORY_EXTRACTION_CHECK_SECONDS",
      60,
      { min: 5, max: 3_600 },
    ) * 1_000,
  memoryAudit: Object.freeze({
    enabled: configuredBoolean("logging.memory.enabled", "JJ_MEMORY_AUDIT_ENABLED", true),
    path: resolve(
      projectRoot,
      String(configured("logging.memory.path", "JJ_MEMORY_AUDIT_PATH", "logs/memory-events.jsonl")),
    ),
    maxBytes: configuredInteger("logging.memory.maxBytes", "JJ_MEMORY_AUDIT_MAX_BYTES", 5 * 1024 * 1024, {
      min: 1_024,
      max: 1024 * 1024 * 1024,
    }),
    maxArchives: configuredInteger("logging.memory.maxArchives", "JJ_MEMORY_AUDIT_MAX_ARCHIVES", 5, {
      min: 1,
      max: 100,
    }),
    includeBodies: false,
    maxValueChars: 10_000,
  }),
  runtimeControlEnabled: configuredBoolean("runtimeControl.enabled", "JJ_RUNTIME_CONTROL_ENABLED", true),
  runtimeControlStatePath: resolve(
    projectRoot,
    String(configured("runtimeControl.statePath", "JJ_RUNTIME_CONTROL_STATE_PATH", "state/runtime-control.json")),
  ),
  runtimeControlRestartEnabled: configuredBoolean(
    "runtimeControl.restartEnabled",
    "JJ_RUNTIME_CONTROL_RESTART_ENABLED",
    false,
  ),
  runtimeControlRestartDelayMs: configuredInteger(
    "runtimeControl.restartDelayMs",
    "JJ_RUNTIME_CONTROL_RESTART_DELAY_MS",
    750,
    { min: 250, max: 10_000 },
  ),
  runtimeControlRestartExitCode: configuredInteger(
    "runtimeControl.restartExitCode",
    "JJ_RUNTIME_CONTROL_RESTART_EXIT_CODE",
    75,
    { min: 1, max: 255 },
  ),
  runtimeControlAllowUsernameFallback: configuredBoolean(
    "runtimeControl.allowUsernameFallback",
    "JJ_RUNTIME_CONTROL_USERNAME_FALLBACK",
    true,
  ),
  runtimeControlAudit: Object.freeze({
    enabled: configuredBoolean("logging.runtimeControl.enabled", "JJ_RUNTIME_CONTROL_AUDIT_ENABLED", true),
    path: resolve(
      projectRoot,
      String(configured("logging.runtimeControl.path", "JJ_RUNTIME_CONTROL_AUDIT_PATH", "logs/runtime-control.jsonl")),
    ),
    maxBytes: configuredInteger("logging.runtimeControl.maxBytes", "JJ_RUNTIME_CONTROL_AUDIT_MAX_BYTES", 5 * 1024 * 1024, { min: 1_024, max: 1024 * 1024 * 1024 }),
    maxArchives: configuredInteger("logging.runtimeControl.maxArchives", "JJ_RUNTIME_CONTROL_AUDIT_MAX_ARCHIVES", 5, { min: 1, max: 100 }),
    includeBodies: false,
    maxValueChars: 10_000,
  }),
  spontaneousEnabled: spontaneousParticipationEnabled,
  spontaneousMinMessages,
  spontaneousMaxMessages,
  spontaneousCooldownMs:
    integer("JJ_SPONTANEOUS_COOLDOWN_MINUTES", 20, { min: 1, max: 1_440 }) * 60_000,
  spontaneousMaxPerHour: integer("JJ_SPONTANEOUS_MAX_PER_HOUR", 2, { min: 1, max: 20 }),
  spontaneousMinChars: integer("JJ_SPONTANEOUS_MIN_CHARS", 12, { min: 1, max: 500 }),
});
