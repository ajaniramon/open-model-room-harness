import { copyFile, chmod, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { resolveTimeZone } from "../src/message-time.js";
import {
  DEFAULT_LOCAL_BASE_URL,
  normalizeOpenAiCompatibleBaseUrl,
} from "../src/openai-compatible.js";

const root = resolve(import.meta.dirname, "..");
const envPath = resolve(root, ".env");
const promptPath = resolve(root, "src", "system-prompt.txt");
const promptExamplePath = resolve(root, "src", "system-prompt.example.txt");

async function ask(question, fallback = "") {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const suffix = fallback ? ` [${fallback}]` : "";
    const answer = (await rl.question(`${question}${suffix}: `)).trim();
    return answer || fallback;
  } finally {
    rl.close();
  }
}

async function askSecret(question, required = false) {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
    const value = await ask(`${question} (input will be visible)`);
    if (required && !value) throw new Error(`${question} is required.`);
    return value;
  }

  process.stdout.write(`${question}: `);
  const value = await new Promise((resolveValue, reject) => {
    let buffer = "";
    const wasRaw = process.stdin.isRaw;
    const cleanup = () => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(wasRaw);
      process.stdin.pause();
    };
    const onData = (chunk) => {
      for (const character of chunk.toString("utf8")) {
        if (character === "\u0003") {
          cleanup();
          process.stdout.write("\n");
          reject(new Error("Setup cancelled."));
          return;
        }
        if (character === "\r" || character === "\n") {
          cleanup();
          process.stdout.write("\n");
          resolveValue(buffer);
          return;
        }
        if (character === "\u007f" || character === "\b") {
          if (buffer) {
            buffer = buffer.slice(0, -1);
            process.stdout.write("\b \b");
          }
          continue;
        }
        if (character >= " " && character !== "\u007f") {
          buffer += character;
          process.stdout.write("*");
        }
      }
    };
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", onData);
  });

  if (required && !value.trim()) throw new Error(`${question} is required.`);
  return value.trim();
}

async function confirm(question, fallback = true) {
  const marker = fallback ? "Y/n" : "y/N";
  const answer = (await ask(`${question} (${marker})`)).toLowerCase();
  if (!answer) return fallback;
  return answer === "y" || answer === "yes";
}

async function choose(question, choices, fallback) {
  console.log(`\n${question}`);
  choices.forEach((choice, index) => {
    const marker = choice.value === fallback ? " (default)" : "";
    console.log(`  ${index + 1}. ${choice.label}${marker}`);
  });
  while (true) {
    const answer = (await ask("Choose a provider", fallback)).toLowerCase();
    const byNumber = choices[Number.parseInt(answer, 10) - 1];
    const byValue = choices.find((choice) => choice.value === answer);
    if (byNumber) return byNumber.value;
    if (byValue) return byValue.value;
    console.log(`Enter 1-${choices.length} or one of: ${choices.map((choice) => choice.value).join(", ")}.`);
  }
}

function run(command, args) {
  const useCommandProcessor = process.platform === "win32" && command.endsWith(".cmd");
  const executable = useCommandProcessor ? process.env.ComSpec || "cmd.exe" : command;
  const executableArgs = useCommandProcessor ? ["/d", "/c", command, ...args] : args;
  const result = spawnSync(executable, executableArgs, {
    cwd: root,
    stdio: "inherit",
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}.`);
  }
}

console.log("\nOpen Model Room Harness setup");
console.log("=============================\n");

try {
  await readFile(envPath, "utf8");
  if (!(await confirm(".env already exists. Replace it", false))) {
    console.log("Setup cancelled without changing .env.");
    process.exit(0);
  }
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

const discordToken = await askSecret("Discord bot token", true);
const providerDefinitions = {
  nanogpt: {
    label: "NanoGPT",
    keyEnv: "NANOGPT_API_KEY",
    keyPrompt: "NanoGPT API key",
    modelEnv: "NANOGPT_MODEL",
    defaultModel: "xiaomi/mimo-v2.5-pro:thinking",
  },
  openai: {
    label: "OpenAI",
    keyEnv: "OPENAI_API_KEY",
    keyPrompt: "OpenAI API key",
    modelEnv: "OPENAI_MODEL",
    defaultModel: "gpt-5.6-terra",
  },
  anthropic: {
    label: "Anthropic",
    keyEnv: "ANTHROPIC_API_KEY",
    keyPrompt: "Anthropic API key",
    modelEnv: "ANTHROPIC_MODEL",
    defaultModel: "claude-sonnet-5",
  },
  xai: {
    label: "xAI / Grok",
    keyEnv: "XAI_API_KEY",
    keyPrompt: "xAI API key",
    modelEnv: "XAI_MODEL",
    defaultModel: "grok-4.5",
  },
  gemini: {
    label: "Google Gemini",
    keyEnv: "GEMINI_API_KEY",
    keyPrompt: "Gemini API key",
    modelEnv: "GEMINI_MODEL",
    defaultModel: "gemini-3.6-flash",
  },
  local: {
    label: "Local / OpenAI",
    keyEnv: "LOCAL_API_KEY",
    keyPrompt: "Local API key (optional; press Enter for none)",
    modelEnv: "LOCAL_MODEL",
    baseUrlEnv: "LOCAL_BASE_URL",
    defaultModel: "local-model",
    defaultBaseUrl: DEFAULT_LOCAL_BASE_URL,
    apiKeyOptional: true,
  },
};
const modelProvider = await choose(
  "Select the primary conversation provider:",
  Object.entries(providerDefinitions).map(([value, definition]) => ({
    value,
    label: definition.label,
  })),
  "nanogpt",
);
const providerDefinition = providerDefinitions[modelProvider];
const primaryApiKey = await askSecret(
  providerDefinition.keyPrompt,
  !providerDefinition.apiKeyOptional,
);
const primaryBaseUrl = providerDefinition.baseUrlEnv
  ? normalizeOpenAiCompatibleBaseUrl(
      await ask("Local OpenAI-compatible API base URL", providerDefinition.defaultBaseUrl),
    )
  : "";
const primaryModel = await ask(
  `${providerDefinition.label} conversation model`,
  providerDefinition.defaultModel,
);
const nanoGptApiKey =
  modelProvider === "nanogpt"
    ? primaryApiKey
    : await askSecret(
        "NanoGPT API key for optional vision, images, and NanoGPT escalation routes",
      );
const tavilyApiKey = await askSecret("Tavily API key (optional)");
const elevenLabsApiKey = await askSecret("ElevenLabs API key (optional)");

let ownerId = await ask("Owner Discord user ID (recommended)");
let ownerUsername = await ask("Owner Discord username (fallback)");
while (!ownerId && !ownerUsername) {
  console.log("At least one owner identity is required to protect paid and local tools.");
  ownerId = await ask("Owner Discord user ID (recommended)");
  ownerUsername = await ask("Owner Discord username (fallback)");
}

const botName = await ask("Bot character name", "JJ");
const visualIdentity = await ask(
  "Canonical visual identity (one line, optional)",
  "A distinctive adult AI engineering team lead; customize this description.",
);
const timeZone = resolveTimeZone(
  await ask(
    "IANA time zone for message timestamps",
    Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  ),
);
const voiceId = elevenLabsApiKey
  ? await ask("ElevenLabs voice ID", "21m00Tcm4TlvDq8ikWAM")
  : "21m00Tcm4TlvDq8ikWAM";
const installCodex = await confirm(
  "Install the optional Codex CLI for local delegated tasks",
  false,
);

const ownerIds = ownerId.trim();
const ownerNames = ownerUsername.trim();
const values = {
  DISCORD_TOKEN: discordToken,
  MODEL_PROVIDER: modelProvider,
  NANOGPT_API_KEY: nanoGptApiKey,
  [providerDefinition.keyEnv]: primaryApiKey,
  [providerDefinition.modelEnv]: primaryModel,
  ...(providerDefinition.baseUrlEnv
    ? { [providerDefinition.baseUrlEnv]: primaryBaseUrl }
    : {}),
  TAVILY_API_KEY: tavilyApiKey,
  ELEVENLABS_API_KEY: elevenLabsApiKey,
  ELEVENLABS_VOICE_ID: voiceId,
  JJ_VISUAL_IDENTITY: visualIdentity,
  JJ_BLOCKED_USERNAMES: "",
  JJ_CONTEXT_TIMESTAMPS: "true",
  JJ_TIME_ZONE: timeZone,
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

const envText =
  "# Generated by npm run setup. Never commit this file.\n" +
  Object.entries(values)
    .map(([key, value]) => `${key}=${JSON.stringify(String(value))}`)
    .join("\n") +
  "\n";
await writeFile(envPath, envText, { encoding: "utf8", mode: 0o600 });
await chmod(envPath, 0o600).catch(() => undefined);

try {
  await readFile(promptPath, "utf8");
  console.log("Keeping the existing private src/system-prompt.txt.");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  await copyFile(promptExamplePath, promptPath);
  const prompt = await readFile(promptPath, "utf8");
  await writeFile(
    promptPath,
    prompt.replaceAll("{{BOT_NAME}}", botName),
    "utf8",
  );
  console.log("Created private src/system-prompt.txt from the safe example.");
}

console.log("\nInstalling project dependencies...");
run(process.platform === "win32" ? "npm.cmd" : "npm", ["install"]);

if (installCodex) {
  console.log("\nInstalling Codex CLI...");
  run(process.platform === "win32" ? "npm.cmd" : "npm", [
    "install",
    "--global",
    "@openai/codex",
  ]);
}

if (await confirm("Run the test suite now", true)) {
  run(process.platform === "win32" ? "npm.cmd" : "npm", ["test"]);
}

console.log("\nSetup complete.");
console.log("1. Enable Message Content Intent in the Discord Developer Portal.");
console.log("2. Invite the bot with the permissions listed in README.md.");
console.log("3. Start it with: npm start");
