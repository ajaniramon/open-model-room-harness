import { access } from "node:fs/promises";
import { createConnection } from "node:net";
import { resolve } from "node:path";
import { config } from "../src/config.js";
import { loadJsonConfig } from "../src/config-source.js";

const root = resolve(import.meta.dirname, "..");

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function portOpen(host, port, timeoutMs = 300) {
  return new Promise((resolvePort) => {
    const socket = createConnection({ host, port });
    const done = (open) => {
      socket.destroy();
      resolvePort(open);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

function findNumericDiscordIds(value, path = []) {
  const hits = [];
  if (Array.isArray(value)) {
    value.forEach((entry, index) => hits.push(...findNumericDiscordIds(entry, [...path, index])));
    return hits;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      hits.push(...findNumericDiscordIds(entry, [...path, key]));
    }
    return hits;
  }
  if (typeof value === "number" && value > 1_000_000_000_000_000) {
    hits.push(path.join("."));
  }
  return hits;
}

const blockers = [];
const warnings = [];

if (!config.discordToken) blockers.push("DISCORD_TOKEN is missing.");
if (config.chatApiKeyEnv && !config.chatApiKey) {
  blockers.push(`${config.chatApiKeyEnv} is missing for MODEL_PROVIDER=${config.chatProvider}.`);
}

const promptPath = resolve(root, "src", "system-prompt.txt");
const promptExamplePath = resolve(root, "src", "system-prompt.example.txt");
if (config.chatProvider !== "none" && !(await exists(promptPath))) {
  if (await exists(promptExamplePath)) {
    warnings.push("src/system-prompt.txt is missing; startup will use src/system-prompt.example.txt.");
  } else {
    blockers.push("Both src/system-prompt.txt and src/system-prompt.example.txt are missing.");
  }
}

const rawConfig = loadJsonConfig(config.configPath);
const numericIds = findNumericDiscordIds(rawConfig);
if (numericIds.length) {
  blockers.push(`config.json contains numeric Discord IDs; quote them as strings: ${numericIds.join(", ")}.`);
}

if (config.mcpControl.enabled) {
  if (!config.mcpControl.bearerToken) blockers.push("MCP control is enabled but MCP_CONTROL_BEARER_TOKEN is missing.");
  if (await portOpen(config.mcpControl.host, config.mcpControl.port)) {
    blockers.push(
      `MCP control port ${config.mcpControl.host}:${config.mcpControl.port} is already in use. ` +
        "Stop the other MCP process or disable MCP_CONTROL_ENABLED for this process.",
    );
  }
}

if (config.memoryEnabled && !config.memoryAllowedUserIds.size && !config.memoryAllowedUsernames.size) {
  warnings.push("Memory is enabled but no memory owner identities are configured.");
}

if (
  config.chatProvider === "none" &&
  !config.chatRelay.enabled &&
  config.behaviorMode.enabled &&
  config.behaviorMode.defaultMode === "auto"
) {
  warnings.push("MODEL_PROVIDER=none with behavior default auto can produce provider-disabled test replies spontaneously.");
}
if (config.chatProvider === "none" && config.chatRelay.enabled) {
  warnings.push("MODEL_PROVIDER=none with chat relay enabled will queue model-bound Discord turns for MCP replies.");
}

if (config.discordEmojiPalette.length > 8) {
  warnings.push("Discord emoji palette is longer than 8 entries; only the first 8 are used.");
}

console.log("Preflight summary");
console.log("=================");
console.log(`provider: ${config.chatProvider}`);
console.log(`model: ${config.chatModel}`);
console.log(`mcpControl: ${config.mcpControl.enabled ? `${config.mcpControl.host}:${config.mcpControl.port}` : "disabled"}`);
console.log(`behaviorMode: ${config.behaviorMode.enabled ? config.behaviorMode.defaultMode : "disabled"}`);
console.log(`memory: ${config.memoryEnabled ? "enabled" : "disabled"}`);
console.log(`discordEmojiPalette: ${config.discordEmojiPalette.length}`);
console.log(`chatRelay: ${config.chatRelay.enabled ? "enabled" : "disabled"}`);

for (const warning of warnings) console.log(`[warn] ${warning}`);
for (const blocker of blockers) console.log(`[blocker] ${blocker}`);

if (blockers.length) {
  process.exitCode = 1;
} else {
  console.log("[ok] No startup blockers found.");
}
