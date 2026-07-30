import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { AudioModeState, ElevenLabsTtsClient } from "./audio-mode.js";
import { config } from "./config.js";
import { CodexRunner } from "./codex-runner.js";
import { createDiscordBot } from "./discord-bot.js";
import { NanoGptImageClient } from "./image-generation.js";
import { JJ_VISUAL_IDENTITY_SYSTEM_SECTION } from "./jj-identity.js";
import { ModelClient } from "./model-client.js";
import { VisionAnalyzer } from "./vision.js";
import { TavilyClient, WebToolRuntime } from "./web-tools.js";

const promptUrl = new URL("./system-prompt.txt", import.meta.url);
for (const [name, value] of [
  ["DISCORD_TOKEN", config.discordToken],
  [config.chatApiKeyEnv, config.chatApiKey],
]) {
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}. Run npm run setup first.`,
    );
  }
}
const systemPrompt =
  `${(await readFile(fileURLToPath(promptUrl), "utf8")).trim()}\n\n` +
  JJ_VISUAL_IDENTITY_SYSTEM_SECTION;
const webTools = new WebToolRuntime(new TavilyClient(config.tavilyApiKey));
const modelClient = new ModelClient(config, fetch, webTools);
const audioModeState = new AudioModeState(config.audioModeStatePath);
await audioModeState.load();
const elevenLabs = new ElevenLabsTtsClient(config);
const imageClient = new NanoGptImageClient(config);
const visionAnalyzer = new VisionAnalyzer(config, modelClient);
const codexRunner = new CodexRunner({
  executable: config.codexExecutable,
  workspace: config.codexWorkspace,
  timeoutMs: config.codexTimeoutMs,
  maxTaskChars: config.codexMaxTaskChars,
  maxResultChars: config.codexMaxResultChars,
  projectWorkspace: config.codexProjectWorkspace,
  yoloWorkspace: config.codexYoloWorkspace,
});
const client = createDiscordBot({
  config,
  nanoGpt: modelClient,
  codexRunner,
  audioModeState,
  elevenLabs,
  imageClient,
  visionAnalyzer,
  systemPrompt,
});

const shutdown = async (signal) => {
  console.info(`Received ${signal}; disconnecting JJ.`);
  client.destroy();
  process.exit(0);
};

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

await client.login(config.discordToken);
