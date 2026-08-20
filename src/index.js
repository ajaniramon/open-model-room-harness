import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { AudioModeState, ElevenLabsTtsClient } from "./audio-mode.js";
import { BehaviorModeController } from "./behavior-mode.js";
import { ChatRelayQueue } from "./chat-relay.js";
import { config } from "./config.js";
import { CodexRunner } from "./codex-runner.js";
import { createDiscordBot } from "./discord-bot.js";
import { DiscordConnectivityWatchdog } from "./discord-watchdog.js";
import { NanoGptImageClient } from "./image-generation.js";
import { JJ_VISUAL_IDENTITY_SYSTEM_SECTION } from "./jj-identity.js";
import { MemoryDigester } from "./memory-digest.js";
import { MemoryStore } from "./memory-store.js";
import { ModelClient } from "./model-client.js";
import { ParticipationController } from "./participation-policy.js";
import { JsonlRequestLogger } from "./request-logger.js";
import { RuntimeControl } from "./runtime-control.js";
import { VisionAnalyzer } from "./vision.js";
import { TavilyClient, WebPagePrefetcher, WebToolRuntime } from "./web-tools.js";
import { FxTwitterClient, KeylessXDiscovery, XPostPrefetcher } from "./x-tools.js";

const promptUrl = new URL("./system-prompt.txt", import.meta.url);
const promptExampleUrl = new URL("./system-prompt.example.txt", import.meta.url);
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
async function loadSystemPrompt() {
  if (config.chatProvider === "none") return "";
  try {
    return (await readFile(fileURLToPath(promptUrl), "utf8")).trim();
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const fallback = (await readFile(fileURLToPath(promptExampleUrl), "utf8"))
      .replaceAll("{{BOT_NAME}}", "the bot")
      .trim();
    console.warn("src/system-prompt.txt is missing; using bundled example prompt for this run.");
    return fallback;
  }
}

const baseSystemPrompt = await loadSystemPrompt();
const systemPrompt = config.chatProvider === "none"
  ? ""
  : `${baseSystemPrompt}\n\n${JJ_VISUAL_IDENTITY_SYSTEM_SECTION}`;
const xDiscovery = new KeylessXDiscovery();
const fxTwitter = new FxTwitterClient(
  fetch,
  undefined,
  xDiscovery.searchPostUrls.bind(xDiscovery),
);
const tavily = new TavilyClient(config.tavilyApiKey);
const webTools = new WebToolRuntime(tavily, fxTwitter);
const xPostPrefetcher = config.xPrefetchEnabled
  ? new XPostPrefetcher({
      client: fxTwitter,
      maxPosts: config.xPrefetchMaxPosts,
      maxChars: config.xPrefetchMaxChars,
    })
  : null;
const webPagePrefetcher = config.webPrefetchEnabled && config.tavilyApiKey
  ? new WebPagePrefetcher({
      client: tavily,
      maxUrls: config.webPrefetchMaxUrls,
      maxChars: config.webPrefetchMaxChars,
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
const behaviorModeController = await new BehaviorModeController({
  settings: config.behaviorMode,
  statePath: config.behaviorMode.statePath,
  auditLogger: runtimeControlAuditLogger,
}).load();
const runtimeControl = config.runtimeControlEnabled
  ? await new RuntimeControl({
      statePath: config.runtimeControlStatePath,
      behaviorModeController,
      auditLogger: runtimeControlAuditLogger,
      restartEnabled: config.runtimeControlRestartEnabled,
    }).load()
  : null;
await behaviorModeController.startWatching();
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
const chatRelay = await new ChatRelayQueue(config.chatRelay).load();
const memoryDigester =
  memoryStore && config.memoryExtractionEnabled
    ? new MemoryDigester({
        store: memoryStore,
        modelClient,
        config,
        runtimeControl,
        behaviorModeController,
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
let discordWatchdog = null;
let mcpControlServer = null;
let shuttingDown = false;
const shutdown = async (signal, exitCode = 0) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.info(`Received ${signal}; disconnecting companion.`);
  discordWatchdog?.stop();
  client?.destroy();
  await chatRelay?.flush();
  await participationController.close();
  await memoryDigester?.close();
  await memoryStore?.close();
  await mcpControlServer?.close();
  await behaviorModeController?.close();
  await participationAuditLogger.close();
  await memoryAuditLogger.close();
  await runtimeControl?.close();
  process.exit(exitCode);
};
const requestRuntimeRestart = (reason = "owner runtime restart") => {
  const timer = setTimeout(
    () => shutdown(reason, config.runtimeControlRestartExitCode),
    config.runtimeControlRestartDelayMs,
  );
  timer.unref();
};

mcpControlServer = config.mcpControl.enabled
  ? (await import("./mcp-control-server.js")).startMcpControlServer({
      config,
      behaviorModeController,
      runtimeControl,
      participationController,
      requestRuntimeRestart,
      memoryStore,
      memoryDigester,
      audioModeState,
      audioConfigured: elevenLabs.configured,
      chatRelay,
      discordClient: () => client,
      discordWatchdog: () => discordWatchdog,
      auditLogger: runtimeControlAuditLogger,
    })
  : null;

client = createDiscordBot({
  config,
  nanoGpt: modelClient,
  codexRunner,
  audioModeState,
  elevenLabs,
  imageClient,
  visionAnalyzer,
  xPostPrefetcher,
  webPagePrefetcher,
  participationController,
  memoryStore,
  memoryDigester,
  runtimeControl,
  behaviorModeController,
  chatRelay,
  requestRuntimeRestart,
  systemPrompt,
});
discordWatchdog = new DiscordConnectivityWatchdog({
  client,
  ...config.discordWatchdog,
  requestRestart: requestRuntimeRestart,
}).start();

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

await client.login(config.discordToken);
