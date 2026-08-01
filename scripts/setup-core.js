import { chmod, copyFile, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { resolveTimeZone } from "../src/message-time.js";
import {
  DEFAULT_LOCAL_BASE_URL,
  normalizeOpenAiCompatibleBaseUrl,
} from "../src/openai-compatible.js";

export const root = resolve(import.meta.dirname, "..");
export const envPath = resolve(root, ".env");
export const configPath = resolve(root, "config.json");
export const promptPath = resolve(root, "src", "system-prompt.txt");
export const promptExamplePath = resolve(root, "src", "system-prompt.example.txt");

export const providerDefinitions = Object.freeze({
  nanogpt: {
    label: "NanoGPT",
    keyEnv: "NANOGPT_API_KEY",
    modelEnv: "NANOGPT_MODEL",
    defaultModel: "xiaomi/mimo-v2.5-pro:thinking",
  },
  openai: {
    label: "OpenAI",
    keyEnv: "OPENAI_API_KEY",
    modelEnv: "OPENAI_MODEL",
    defaultModel: "gpt-5.6-terra",
  },
  anthropic: {
    label: "Anthropic",
    keyEnv: "ANTHROPIC_API_KEY",
    modelEnv: "ANTHROPIC_MODEL",
    defaultModel: "claude-sonnet-5",
  },
  xai: {
    label: "xAI / Grok",
    keyEnv: "XAI_API_KEY",
    modelEnv: "XAI_MODEL",
    defaultModel: "grok-4.5",
  },
  gemini: {
    label: "Google Gemini",
    keyEnv: "GEMINI_API_KEY",
    modelEnv: "GEMINI_MODEL",
    defaultModel: "gemini-3.6-flash",
  },
  local: {
    label: "Local / OpenAI",
    keyEnv: "LOCAL_API_KEY",
    modelEnv: "LOCAL_MODEL",
    baseUrlEnv: "LOCAL_BASE_URL",
    defaultModel: "local-model",
    defaultBaseUrl: DEFAULT_LOCAL_BASE_URL,
    apiKeyOptional: true,
  },
});

function clean(value, maximum = 20_000) {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

function wholeNumber(value, fallback, label, min, max) {
  const parsed = value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${label} must be an integer between ${min} and ${max}.`);
  }
  return parsed;
}

export function validateSetup(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Configuration payload is invalid.");
  }
  const provider = clean(input.provider, 30).toLowerCase();
  const definition = providerDefinitions[provider];
  if (!definition) throw new Error("Choose a supported model provider.");
  if (!clean(input.discordToken)) throw new Error("Discord bot token is required.");
  if (!definition.apiKeyOptional && !clean(input.primaryApiKey)) {
    throw new Error(`${definition.label} API key is required.`);
  }
  if (!clean(input.model, 300)) throw new Error("A conversation model ID is required.");
  if (!clean(input.ownerId, 100) && !clean(input.ownerUsername, 100)) {
    throw new Error("Add an owner Discord user ID or username.");
  }
  if (input.ownerId && !/^\d{15,22}$/.test(clean(input.ownerId, 100))) {
    throw new Error("Discord user IDs contain 15–22 digits. Use the username field as a fallback.");
  }
  let baseUrl = "";
  if (definition.baseUrlEnv) {
    baseUrl = normalizeOpenAiCompatibleBaseUrl(
      clean(input.baseUrl, 2_000) || definition.defaultBaseUrl,
    );
  }
  const participation = {
    budget: {
      maxResponses: wholeNumber(input.budgetMaxResponses, 12, "Global response budget", 1, 500),
      windowMinutes: wholeNumber(input.budgetWindowMinutes, 10, "Budget window", 1, 1_440),
    },
    conversation: {
      turns: wholeNumber(input.conversationTurns, 5, "Conversation turns", 1, 20),
      idleMinutes: wholeNumber(input.conversationIdleMinutes, 10, "Conversation idle expiry", 1, 1_440),
    },
    cooldown: {
      baseSeconds: wholeNumber(input.cooldownBaseSeconds, 3, "Cooldown base", 0, 3_600),
      maxSeconds: wholeNumber(input.cooldownMaxSeconds, 60, "Cooldown maximum", 0, 86_400),
    },
    autobanEnabled: input.autobanEnabled !== false,
  };
  if (participation.cooldown.maxSeconds < participation.cooldown.baseSeconds) {
    throw new Error("Cooldown maximum must be at least the cooldown base.");
  }
  return {
    provider,
    discordToken: clean(input.discordToken),
    primaryApiKey: clean(input.primaryApiKey),
    model: clean(input.model, 300),
    baseUrl,
    nanoGptApiKey: provider === "nanogpt" ? clean(input.primaryApiKey) : clean(input.nanoGptApiKey),
    tavilyApiKey: clean(input.tavilyApiKey),
    elevenLabsApiKey: clean(input.elevenLabsApiKey),
    voiceId: clean(input.voiceId, 200) || "21m00Tcm4TlvDq8ikWAM",
    ownerId: clean(input.ownerId, 100),
    ownerUsername: clean(input.ownerUsername, 100),
    botName: clean(input.botName, 80) || "JJ",
    timeZone: resolveTimeZone(clean(input.timeZone, 100)),
    participation,
    visualIdentity:
      clean(input.visualIdentity, 800) ||
      "A distinctive adult AI engineering team lead; customize this description.",
    installCodex: input.installCodex === true,
    runTests: input.runTests !== false,
    replaceExisting: input.replaceExisting === true,
  };
}

export function buildEnvText(config) {
  const definition = providerDefinitions[config.provider];
  const ownerIds = config.ownerId;
  const ownerNames = config.ownerUsername;
  const values = {
    DISCORD_TOKEN: config.discordToken,
    MODEL_PROVIDER: config.provider,
    NANOGPT_API_KEY: config.nanoGptApiKey,
    [definition.keyEnv]: config.primaryApiKey,
    [definition.modelEnv]: config.model,
    ...(definition.baseUrlEnv ? { [definition.baseUrlEnv]: config.baseUrl } : {}),
    TAVILY_API_KEY: config.tavilyApiKey,
    ELEVENLABS_API_KEY: config.elevenLabsApiKey,
    ELEVENLABS_VOICE_ID: config.voiceId,
    JJ_VISUAL_IDENTITY: config.visualIdentity,
    JJ_BLOCKED_USERNAMES: "",
    JJ_CONTEXT_TIMESTAMPS: "true",
    JJ_TIME_ZONE: config.timeZone,
    JJ_OWNER_USER_IDS: ownerIds,
    JJ_OWNER_USERNAMES: ownerNames,
    JJ_WEB_ALLOWED_USER_IDS: ownerIds,
    JJ_WEB_ALLOWED_USERNAMES: ownerNames,
    JJ_AUDIO_ALLOWED_USER_IDS: ownerIds,
    JJ_AUDIO_ALLOWED_USERNAMES: ownerNames,
    JJ_IMAGE_ALLOWED_USER_IDS: ownerIds,
    JJ_IMAGE_ALLOWED_USERNAMES: ownerNames,
    JJ_CODEX_ALLOWED_USER_IDS: ownerIds,
    JJ_CODEX_ALLOWED_USERNAMES: ownerNames,
    JJ_CODEX_YOLO_ENABLED: "false",
    JJ_CODEX_YOLO_WORKSPACE: "",
    JJ_ESCALATION_ALLOWED_USER_IDS: ownerIds,
    JJ_ESCALATION_ALLOWED_USERNAMES: ownerNames,
  };
  return (
    "# Generated by the Open Model Room Harness installer. Never commit this file.\n" +
    Object.entries(values)
      .map(([key, value]) => `${key}=${JSON.stringify(String(value))}`)
      .join("\n") +
    "\n"
  );
}

export function buildConfigJson(config) {
  const participation = config.participation;
  return `${JSON.stringify({
    permissions: {
      owner: {
        allowedUserIds: config.ownerId ? [config.ownerId] : [],
        allowedUsernames: config.ownerUsername ? [config.ownerUsername.toLowerCase()] : [],
      },
    },
    participation: {
      enabled: true,
      budget: participation.budget,
      conversation: participation.conversation,
      cooldown: {
        baseSeconds: participation.cooldown.baseSeconds,
        multiplier: 2,
        maxSeconds: participation.cooldown.maxSeconds,
        decaySeconds: 120,
        resetMinutes: 10,
      },
      autoban: {
        enabled: participation.autobanEnabled,
        triggers: 8,
        windowSeconds: 20,
        cooldownRejections: 4,
        durationMinutes: 10,
        repeatWindowHours: 24,
        repeatDurationMinutes: 60,
        maxDurationMinutes: 360,
      },
      statePath: "state/participation-state.json",
    },
    logging: {
      participation: {
        enabled: true,
        path: "logs/participation-events.jsonl",
        maxBytes: 5_242_880,
        maxArchives: 5,
      },
    },
  }, null, 2)}\n`;
}

async function atomicPrivateWrite(path, contents) {
  const temporaryPath = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const backupPath = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.bak`;
  let backedUp = false;
  try {
    await writeFile(temporaryPath, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
    if (await pathExists(path)) {
      await rename(path, backupPath);
      backedUp = true;
    }
    await rename(temporaryPath, path);
    await chmod(path, 0o600).catch(() => undefined);
    if (backedUp) await unlink(backupPath).catch(() => undefined);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    if (backedUp && !(await pathExists(path))) {
      await rename(backupPath, path).catch(() => undefined);
    }
    throw error;
  }
}

export async function pathExists(path) {
  try {
    await readFile(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

export async function writeSetupFiles(config) {
  if (((await pathExists(envPath)) || (await pathExists(configPath))) && !config.replaceExisting) {
    throw new Error("Configuration already exists. Confirm replacement to continue.");
  }
  await atomicPrivateWrite(envPath, buildEnvText(config));
  await atomicPrivateWrite(configPath, buildConfigJson(config));
  if (!(await pathExists(promptPath))) {
    await copyFile(promptExamplePath, promptPath);
    const prompt = (await readFile(promptPath, "utf8")).replaceAll("{{BOT_NAME}}", config.botName);
    await atomicPrivateWrite(promptPath, prompt);
  }
}

export function runCommand(command, args, onLine = () => {}) {
  return new Promise((resolveRun, reject) => {
    const useCommandProcessor = process.platform === "win32" && command.endsWith(".cmd");
    const executable = useCommandProcessor ? process.env.ComSpec || "cmd.exe" : command;
    const executableArgs = useCommandProcessor ? ["/d", "/c", command, ...args] : args;
    const child = spawn(executable, executableArgs, {
      cwd: root,
      shell: false,
      env: { ...process.env, FORCE_COLOR: "0" },
    });
    let tail = "";
    const consume = (chunk) => {
      tail += chunk.toString("utf8");
      const lines = tail.split(/\r?\n/);
      tail = lines.pop() || "";
      for (const line of lines) if (line.trim()) onLine(line.slice(0, 1_000));
    };
    child.stdout.on("data", consume);
    child.stderr.on("data", consume);
    child.on("error", reject);
    child.on("close", (code) => {
      if (tail.trim()) onLine(tail.slice(0, 1_000));
      if (code === 0) resolveRun();
      else reject(new Error(`${command} failed with exit code ${code}.`));
    });
  });
}

export async function performSetup(config, notify = () => {}) {
  notify("WRITE", "Writing private configuration atomically...");
  await writeSetupFiles(config);
  notify("NPM", "Installing verified project dependencies...");
  await runCommand(process.platform === "win32" ? "npm.cmd" : "npm", ["install"], (line) =>
    notify("NPM", line),
  );
  if (config.installCodex) {
    notify("CODEX", "Installing the optional Codex CLI...");
    await runCommand(
      process.platform === "win32" ? "npm.cmd" : "npm",
      ["install", "--global", "@openai/codex"],
      (line) => notify("CODEX", line),
    );
  }
  if (config.runTests) {
    notify("TEST", "Running the full self-test suite...");
    await runCommand(process.platform === "win32" ? "npm.cmd" : "npm", ["test"], (line) =>
      notify("TEST", line),
    );
  }
  notify("DONE", "RIG ARMED. Run npm start when the Discord permissions are ready.");
}
