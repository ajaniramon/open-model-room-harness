import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
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
if (!new Set(["nanogpt", "openai", "anthropic", "xai", "gemini", "local"]).has(chatProvider)) {
  throw new Error("MODEL_PROVIDER must be one of: nanogpt, openai, anthropic, xai, gemini, local");
}

const spontaneousMinMessages = integer("JJ_SPONTANEOUS_MIN_MESSAGES", 8, { min: 2, max: 100 });
const spontaneousMaxMessages = integer("JJ_SPONTANEOUS_MAX_MESSAGES", 24, { min: 2, max: 200 });
if (spontaneousMaxMessages < spontaneousMinMessages) {
  throw new Error("JJ_SPONTANEOUS_MAX_MESSAGES must be at least JJ_SPONTANEOUS_MIN_MESSAGES");
}

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
  modelProviders,
  nanoGptModel:
    process.env.NANOGPT_MODEL?.trim() ||
    "xiaomi/mimo-v2.5-pro:thinking",
  nanoGptBaseUrl:
    process.env.NANOGPT_BASE_URL?.trim() ||
    "https://nano-gpt.com/api/subscription/v1/chat/completions",
  triggerMode,
  allowedChannelIds: new Set(
    (process.env.JJ_ALLOWED_CHANNEL_IDS || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  ),
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
  spontaneousEnabled: enabled("JJ_SPONTANEOUS_ENABLED", true),
  spontaneousMinMessages,
  spontaneousMaxMessages,
  spontaneousCooldownMs:
    integer("JJ_SPONTANEOUS_COOLDOWN_MINUTES", 20, { min: 1, max: 1_440 }) * 60_000,
  spontaneousMaxPerHour: integer("JJ_SPONTANEOUS_MAX_PER_HOUR", 2, { min: 1, max: 20 }),
  spontaneousMinChars: integer("JJ_SPONTANEOUS_MIN_CHARS", 12, { min: 1, max: 500 }),
});
