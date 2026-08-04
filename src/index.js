import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { AudioModeState, ElevenLabsTtsClient } from "./audio-mode.js";
import { config } from "./config.js";
import { CodexRunner } from "./codex-runner.js";
import { createDiscordBot } from "./discord-bot.js";
import { NanoGptImageClient } from "./image-generation.js";
import { JJ_VISUAL_IDENTITY_SYSTEM_SECTION } from "./jj-identity.js";
import { MemoryDigester } from "./memory-digest.js";
import { MemoryStore } from "./memory-store.js";
import { ModelClient } from "./model-client.js";
import { ParticipationController } from "./participation-policy.js";
import { JsonlRequestLogger } from "./request-logger.js";
import { RuntimeControl } from "./runtime-control.js";
import { VisionAnalyzer } from "./vision.js";
import { TavilyClient, WebToolRuntime } from "./web-tools.js";
import { FxTwitterClient, KeylessXDiscovery, XPostPrefetcher } from "./x-tools.js";

const promptUrl = new URL("./system-prompt.txt", import.meta.url);
const requiredConfiguration = [["DISCORD_TOKEN", config.discordToken]];
if (config.chatApiKeyEnv) {
  requiredConfiguration.push([config.chatApiKeyEnv, config.chatApiKey]);
}
for (const [name, value] of requiredConfiguration) {
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}. Run npm run setup first.`,
    );
  }
}
const systemPrompt =
  `${(await readFile(fileURLToPath(promptUrl), "utf8")).trim()}\n\n` +
  JJ_VISUAL_IDENTITY_SYSTEM_SECTION;
const xDiscovery = new KeylessXDiscovery();
const fxTwitter = new FxTwitterClient(
  fetch,
  undefined,
  xDiscovery.searchPostUrls.bind(xDiscovery),
);
const webTools = new WebToolRuntime(new TavilyClient(config.tavilyApiKey), fxTwitter);
const xPostPrefetcher = config.xPrefetchEnabled
  ? new XPostPrefetcher({
      client: fxTwitter,
      maxPosts: config.xPrefetchMaxPosts,
      maxChars: config.xPrefetchMaxChars,
    })
  : null;
const participationAuditLogger = new JsonlRequestLogger(config.participationAudit);
const participationController = await new ParticipationController({
  policy: config.participationPolicy,
  configPath: config.configPath,
  statePath: config.participationStatePath,
  auditLogger: participationAuditLogger,
}).load();
const runtimeControlAuditLogger = new JsonlRequestLogger(config.runtimeControlAudit);
const runtimeControl = config.runtimeControlEnabled
  ? await new RuntimeControl({
      statePath: config.runtimeControlStatePath,
      auditLogger: runtimeControlAuditLogger,
      restartEnabled: config.runtimeControlRestartEnabled,
    }).load()
  : null;
const memoryAuditLogger = new JsonlRequestLogger(config.memoryAudit);
const memoryStore = config.memoryEnabled
  ? await new MemoryStore({
      path: config.memoryStorePath,
      maxRecords: config.memoryMaxRecords,
      maxPerUser: config.memoryMaxPerUser,
      retentionDays: config.memoryRetentionDays,
      maxTextChars: config.memoryMaxTextChars,
      auditLogger: memoryAuditLogger,
    }).load()
  : null;
const modelClient = new ModelClient(config, fetch, webTools);
const memoryDigester =
  memoryStore && config.memoryExtractionEnabled
    ? new MemoryDigester({
        store: memoryStore,
        modelClient,
        config,
        runtimeControl,
      }).start()
    : null;
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
let client = null;
let shuttingDown = false;
const shutdown = async (signal, exitCode = 0) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.info(`Received ${signal}; disconnecting companion.`);
  client?.destroy();
  await participationController.close();
  await memoryDigester?.close();
  await memoryStore?.close();
  await participationAuditLogger.close();
  await memoryAuditLogger.close();
  await runtimeControl?.close();
  process.exit(exitCode);
};
const requestRuntimeRestart = () => {
  const timer = setTimeout(
    () => shutdown("owner runtime restart", config.runtimeControlRestartExitCode),
    config.runtimeControlRestartDelayMs,
  );
  timer.unref();
};

client = createDiscordBot({
  config,
  nanoGpt: modelClient,
  codexRunner,
  audioModeState,
  elevenLabs,
  imageClient,
  visionAnalyzer,
  xPostPrefetcher,
  participationController,
  memoryStore,
  memoryDigester,
  runtimeControl,
  requestRuntimeRestart,
  systemPrompt,
});

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

await client.login(config.discordToken);
