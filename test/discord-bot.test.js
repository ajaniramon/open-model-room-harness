import assert from "node:assert/strict";
import test from "node:test";
import { ChannelType } from "discord.js";
import {
  allowsXPostPrefetch,
  buildMessageHeader,
  isBlockedAuthor,
  isAudioModeAuthorized,
  isCodexAuthorized,
  isEscalationAuthorized,
  isImageGenerationAuthorized,
  isWebAuthorized,
  compactCodexHandoff,
  compileImagePrompt,
  buildContext,
  formatDiscordEmojiPalette,
  limitCodexDiscordResponse,
  normalizeCompiledImagePrompt,
  parseAudioModeCommand,
  parseEscalationCommand,
  resolveResponseTrigger,
  parseImageGenerationCommand,
  parseCodexDelegation,
  requestsWebTools,
  resolveEscalationModel,
  shouldUseAudioResponse,
  splitDiscordMessage,
} from "../src/discord-bot.js";

test("keeps short Discord messages intact", () => {
  assert.deepEqual(splitDiscordMessage("hola JJ"), ["hola JJ"]);
});

test("splits long responses below the configured limit without losing words", () => {
  const input = Array.from({ length: 40 }, (_, index) => `palabra${index}`).join(" ");
  const chunks = splitDiscordMessage(input, 80);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 80));
  assert.equal(chunks.join(" "), input);
});

test("conversation policy opens on mention, follows the same-user window, then goes silent", async () => {
  let active = false;
  const controller = {
    enabled: true,
    isOwner: () => false,
    hasActiveConversation: () => active,
  };
  const config = {
    blockedUsernames: new Set(),
    respondToBots: false,
    allowedChannelIds: new Set(),
    triggerMode: "all",
  };
  const client = { user: { id: "bot" } };
  const message = {
    author: { id: "person", username: "person", bot: false },
    channel: { type: 0 },
    guildId: "guild",
    channelId: "channel",
    mentions: { has: () => false },
  };

  assert.deepEqual(await resolveResponseTrigger(message, client, config, controller), {
    directResponse: false,
    explicitMention: false,
    continuation: false,
  });
  active = true;
  assert.deepEqual(await resolveResponseTrigger(message, client, config, controller), {
    directResponse: true,
    explicitMention: false,
    continuation: true,
  });
  active = false;
  message.mentions.has = () => true;
  assert.deepEqual(await resolveResponseTrigger(message, client, config, controller), {
    directResponse: true,
    explicitMention: true,
    continuation: false,
  });
});

test("stamps context headers with the post time and its age", () => {
  const header = buildMessageHeader(
    {
      author: { username: "operator", bot: false },
      member: { displayName: "Operator" },
      createdTimestamp: Date.parse("2026-08-01T11:48:00Z"),
    },
    {
      timestamps: true,
      timeZone: "Europe/Madrid",
      now: Date.parse("2026-08-01T12:00:00Z"),
    },
  );
  assert.equal(
    header,
    "[Discord message from Operator at 2026-08-01 13:48:00 Europe/Madrid (12m ago)]",
  );
});

test("formats a Discord-only emoji palette without treating it as memory", async () => {
  const instruction = formatDiscordEmojiPalette([
    "<:spark:123456789012345678>",
    "<a:dance:234567890123456789>",
  ]);
  assert.match(instruction, /custom emoji strings/);
  assert.match(instruction, /<:spark:123456789012345678>/);
  assert.match(instruction, /outside Discord/);
  assert.doesNotMatch(instruction, /Application memory/);

  const message = {
    id: "m1",
    content: "@bot hello",
    guildId: "g1",
    channelId: "c1",
    createdTimestamp: Date.now(),
    author: { id: "u1", username: "owner", bot: false },
    member: { displayName: "Owner" },
    attachments: new Map(),
    channel: {
      messages: {
        fetch: async () => new Map([["m1", message]]),
      },
    },
  };
  const context = await buildContext(
    message,
    { user: { id: "bot" } },
    {
      blockedUsernames: new Set(),
      contextMessages: 5,
      contextTimestamps: false,
      timeZone: "UTC",
      discordEmojiPalette: ["<:spark:123456789012345678>"],
    },
    "System.",
  );
  assert.match(context[0].content, /Application Discord metadata/);
  assert.match(context[0].content, /<:spark:123456789012345678>/);
});

test("marks bots and omits timestamps when the feature is disabled", () => {
  const message = {
    author: { username: "helper", bot: true },
    createdTimestamp: Date.parse("2026-08-01T11:48:00Z"),
  };
  assert.equal(
    buildMessageHeader(message, { timestamps: false, timeZone: "UTC", now: Date.now() }),
    "[Discord message from helper (bot)]",
  );
  assert.match(
    buildMessageHeader(message, {
      timestamps: true,
      timeZone: "UTC",
      now: Date.parse("2026-08-01T12:00:00Z"),
    }),
    /^\[Discord message from helper \(bot\) at 2026-08-01 11:48:00 UTC \(12m ago\)\]$/,
  );
});

test("keeps the header usable when Discord omits the creation timestamp", () => {
  assert.equal(
    buildMessageHeader(
      { author: { username: "ghost" }, createdTimestamp: undefined },
      { timestamps: true, timeZone: "UTC", now: Date.now() },
    ),
    "[Discord message from ghost]",
  );
});

test("blocks exact Discord usernames case-insensitively", () => {
  const config = { blockedUsernames: new Set(["blocked.one", "blocked.two"]) };
  assert.equal(isBlockedAuthor({ username: "blocked.one" }, config), true);
  assert.equal(isBlockedAuthor({ username: "Blocked.One" }, config), true);
  assert.equal(isBlockedAuthor({ username: "blocked.two" }, config), true);
  assert.equal(isBlockedAuthor({ username: "Blocked.Two" }, config), true);
  assert.equal(isBlockedAuthor({ username: "blocked.one.extra" }, config), false);
});

test("authorizes web tools only for configured Discord identities", () => {
  const config = {
    webAllowedUserIds: new Set(["123"]),
    webAllowedUsernames: new Set(["owner_user"]),
  };
  assert.equal(isWebAuthorized({ id: "123", username: "someone" }, config), true);
  assert.equal(isWebAuthorized({ id: "999", username: "Owner_User" }, config), true);
  assert.equal(isWebAuthorized({ id: "999", username: "goblin" }, config), false);
});

test("requires an explicit web action before exposing tools", () => {
  assert.equal(requestsWebTools("@bot busca noticias actuales"), true);
  assert.equal(requestsWebTools("@bot fetch https://example.com"), true);
  assert.equal(requestsWebTools("@bot resume https://example.com"), true);
  assert.equal(requestsWebTools("@bot search X for local AI news"), true);
  assert.equal(requestsWebTools("@bot read https://x.com/jack/status/20"), true);
  assert.equal(requestsWebTools("@bot tweet me a joke"), false);
  assert.equal(requestsWebTools("@bot qué opinas de este enlace https://example.com"), false);
  assert.equal(requestsWebTools("@bot cuéntame un chiste"), false);
});

// A bare X link is handled by the prefetch stage, so it must not silently widen the
// gate that also exposes generic web_search and web_fetch.
test("a bare X post link does not open the web tool gate", () => {
  assert.equal(requestsWebTools("@bot https://x.com/jack/status/20"), false);
  assert.equal(requestsWebTools("look at this https://fxtwitter.com/jack/status/456"), false);
  assert.equal(requestsWebTools("@bot show https://x.com/jack/status/20"), true);
  // A host that merely contains an allowed name must not satisfy the X branch. An
  // explicit web action still opens the gate for any URL, which is a separate branch.
  assert.equal(requestsWebTools("@bot show https://fox.com/news/status/2020"), false);
  assert.equal(requestsWebTools("@bot fetch https://fox.com/news/status/2020"), true);
});

test("prefetches X posts for anyone in a channel but only for the owner in DMs", () => {
  const config = {
    xPrefetchEnabled: true,
    ownerUserIds: new Set(["1"]),
    ownerUsernames: new Set(["owner"]),
  };
  const guildMessage = (author) => ({ channel: { type: ChannelType.GuildText }, author });
  const dm = (author) => ({ channel: { type: ChannelType.DM }, author });

  assert.equal(allowsXPostPrefetch(guildMessage({ id: "9", username: "stranger" }), config), true);
  assert.equal(allowsXPostPrefetch(dm({ id: "1", username: "owner" }), config), true);
  assert.equal(allowsXPostPrefetch(dm({ id: "9", username: "stranger" }), config), false);
  assert.equal(
    allowsXPostPrefetch(guildMessage({ id: "9", username: "stranger" }), {
      ...config,
      xPrefetchEnabled: false,
    }),
    false,
  );
});

test("parses supported escalation command forms", () => {
  assert.deepEqual(
    parseEscalationCommand("@bot escalate to opus-5 :: review the architecture"),
    { requestedModel: "opus-5", task: "review the architecture" },
  );
  assert.deepEqual(
    parseEscalationCommand("@bot escalate to Claude Opus 5 model and do identify two risks"),
    { requestedModel: "Claude Opus 5", task: "identify two risks" },
  );
  assert.deepEqual(
    parseEscalationCommand(
      "@bot please escalate to kimi k3, read memory-improvements.md and write implementation plan. Advise when done.",
    ),
    {
      requestedModel: "kimi k3",
      task: "read memory-improvements.md and write implementation plan. Advise when done.",
    },
  );
  assert.equal(parseEscalationCommand("@bot tell opus to do something"), null);
});

test("restricts escalation identity and resolves only whitelisted models", () => {
  const opus = { model: "anthropic/claude-opus-5" };
  const config = {
    escalationAllowedUserIds: new Set(["123"]),
    escalationAllowedUsernames: new Set(["owner_user"]),
    escalationModels: { "opus-5": opus, "claude opus 5": opus },
  };
  assert.equal(isEscalationAuthorized({ id: "999", username: "OWNER_USER" }, config), true);
  assert.equal(isEscalationAuthorized({ id: "999", username: "goblin" }, config), false);
  assert.equal(resolveEscalationModel("Claude Opus 5", config), opus);
  assert.equal(resolveEscalationModel("totally-real-ultra-model", config), null);
});

test("parses owner-only Codex delegation commands", () => {
  const config = {
    codexAllowedUserIds: new Set(["123"]),
    codexAllowedUsernames: new Set(["owner_user"]),
  };
  assert.deepEqual(parseCodexDelegation("@bot spawn codex :: inspect the project"), {
    task: "inspect the project",
  });
  assert.deepEqual(
    parseCodexDelegation("@bot CODEX YOLO :: find the target repository and run its tests"),
    {
      task: "find the target repository and run its tests",
      yolo: true,
    },
  );
  assert.deepEqual(
    parseCodexDelegation("@bot spawn codex :: explain the phrase codex yolo"),
    { task: "explain the phrase codex yolo" },
  );
  assert.deepEqual(parseCodexDelegation("@bot spawnea un codex para crear una demo"), {
    task: "crear una demo",
  });
  assert.deepEqual(
    parseCodexDelegation(
      "@bot please spawn codex agent to assess memory-implementation-plan. Tell him to find my-harness directory and cross the file with the codebase and advise if viable",
    ),
    {
      task:
        "assess memory-implementation-plan. Tell him to find my-harness directory and cross the file with the codebase and advise if viable",
    },
  );
  assert.deepEqual(
    parseCodexDelegation(
      "@bot please spawn codex agent and tell him to find open-model-room-harness directory and design an implementation plan for X/Twitter integration (read-only, for now only search and post fetch). Advise when done. Do not provide code details over this chat.",
    ),
    {
      task:
        "find open-model-room-harness directory and design an implementation plan for X/Twitter integration (read-only, for now only search and post fetch). Advise when done. Do not provide code details over this chat.",
    },
  );
  assert.deepEqual(
    parseCodexDelegation("@bot launch a codex agent and ask it to inspect the workspace"),
    { task: "inspect the workspace" },
  );
  assert.equal(parseCodexDelegation("@bot qué opinas de Codex"), null);
  assert.equal(isCodexAuthorized({ id: "999", username: "OWNER_USER" }, config), true);
  assert.equal(isCodexAuthorized({ id: "999", username: "goblin" }, config), false);
});

test("parses owner-only audio mode toggles in Spanish and English", () => {
  const config = {
    audioAllowedUserIds: new Set(["123"]),
    audioAllowedUsernames: new Set(["owner_user"]),
  };
  assert.equal(parseAudioModeCommand("@bot activa audio mode"), true);
  assert.equal(parseAudioModeCommand("@bot enable audio mode"), true);
  assert.equal(parseAudioModeCommand("@bot desactiva audio mode"), false);
  assert.equal(parseAudioModeCommand("@bot disable audio mode"), false);
  assert.equal(parseAudioModeCommand("@bot qué opinas del audio mode"), null);
  assert.equal(isAudioModeAuthorized({ id: "999", username: "OWNER_USER" }, config), true);
  assert.equal(isAudioModeAuthorized({ id: "999", username: "goblin" }, config), false);
});

test("uses audio only for direct responses to the configured owner", () => {
  const config = {
    audioAllowedUserIds: new Set(["123"]),
    audioAllowedUsernames: new Set(["owner_user"]),
  };
  assert.equal(
    shouldUseAudioResponse({ id: "999", username: "OWNER_USER" }, true, true, config),
    true,
  );
  assert.equal(
    shouldUseAudioResponse({ id: "999", username: "goblin" }, true, true, config),
    false,
  );
  assert.equal(
    shouldUseAudioResponse({ id: "999", username: "OWNER_USER" }, false, true, config),
    false,
  );
  assert.equal(
    shouldUseAudioResponse({ id: "999", username: "OWNER_USER" }, true, false, config),
    false,
  );
});

test("parses image generation prompts, invention requests, and model selection", () => {
  assert.deepEqual(parseImageGenerationCommand("@bot draw a picture of a robot detective"), {
    prompt: "a robot detective",
    requestedModel: null,
  });
  assert.deepEqual(parseImageGenerationCommand("@bot generate an image"), {
    prompt: null,
    requestedModel: null,
  });
  assert.deepEqual(
    parseImageGenerationCommand("@bot draw a picture of the current situation"),
    {
      prompt: null,
      requestedModel: null,
    },
  );
  assert.deepEqual(
    parseImageGenerationCommand("@bot generate an image of what is happening in cyberpunk style"),
    {
      prompt: null,
      requestedModel: null,
    },
  );
  assert.deepEqual(
    parseImageGenerationCommand("@bot dibuja una imagen de la situaci\u00f3n actual"),
    {
      prompt: null,
      requestedModel: null,
    },
  );
  assert.deepEqual(
    parseImageGenerationCommand(
      "@bot generate an image using model nano-banana-2-lite :: a goblin debugging production",
    ),
    {
      prompt: "a goblin debugging production",
      requestedModel: "nano-banana-2-lite",
    },
  );
  assert.deepEqual(
    parseImageGenerationCommand(
      "@bot create an image with model ideogram/v4/fast :: a technical poster",
    ),
    {
      prompt: "a technical poster",
      requestedModel: "ideogram/v4/fast",
    },
  );
  assert.deepEqual(parseImageGenerationCommand("@bot genera una imagen de lo que quieras"), {
    prompt: null,
    requestedModel: null,
  });
  assert.equal(parseImageGenerationCommand("@bot describe this image"), null);
});

test("authorizes image generation only for configured Discord identities", () => {
  const config = {
    imageAllowedUserIds: new Set(["123"]),
    imageAllowedUsernames: new Set(["owner_user"]),
  };
  assert.equal(isImageGenerationAuthorized({ id: "123", username: "someone" }, config), true);
  assert.equal(isImageGenerationAuthorized({ id: "999", username: "OWNER_USER" }, config), true);
  assert.equal(isImageGenerationAuthorized({ id: "999", username: "goblin" }, config), false);
});

test("accepts concrete compiled image prompts and rejects JJ roleplay", () => {
  assert.equal(
    normalizeCompiledImagePrompt(
      '**Image prompt:** "A chaotic Discord engineering room filled with glowing terminals, a red-haired team lead, and goblin developers debugging an audio bot."',
    ),
    "A chaotic Discord engineering room filled with glowing terminals, a red-haired team lead, and goblin developers debugging an audio bot.",
  );
  assert.equal(
    normalizeCompiledImagePrompt(
      "JJ cracks her knuckles and grins.\n\nOh, you want the current situation immortalized? Here we go:",
    ),
    null,
  );
  assert.equal(normalizeCompiledImagePrompt("the current situation"), null);
});

test("compiles every image brief through the configured prompt model and retries junk", async () => {
  const replies = [
    "JJ rolls over dramatically. Here we go:",
    "A cinematic goblin engineer repairing a glowing production server in a chaotic Discord operations room, surrounded by diagnostic screens, tangled cables, warm work lights, and cool blue monitor glow.",
  ];
  const calls = [];
  const nanoGpt = {
    async complete(messages, options) {
      calls.push({ messages: structuredClone(messages), options });
      return replies.shift();
    },
  };
  const promptContext = [
    { role: "system", content: "compile prompts" },
    { role: "user", content: "@bot draw a goblin engineer" },
  ];
  const config = {
    imagePromptModel: "qwen3.7-flash:thinking",
    imagePromptBaseUrl: "https://nano-gpt.com/api/v1/chat/completions",
  };

  const prompt = await compileImagePrompt(nanoGpt, promptContext, config);

  assert.match(prompt, /^A cinematic goblin engineer/);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].options, {
    provider: "nanogpt",
    model: "qwen3.7-flash:thinking",
    baseUrl: "https://nano-gpt.com/api/v1/chat/completions",
    reasoningEffort: "high",
    maxOutputTokens: 512,
  });
  assert.match(calls[1].messages.at(-1).content, /Preserve the owner's creative brief/);
});

test("keeps delegated Codex reports compact and removes project roots", () => {
  const config = {
    codexProjectWorkspace: "C:\\workspace\\jj-discord-bot",
    codexWorkspace: "C:\\workspace\\jj-discord-bot\\codex-workspace",
  };
  const handoff = compactCodexHandoff(
    `Changed C:\\workspace\\jj-discord-bot\\src\\index.js\n${"x".repeat(7_000)}`,
    config,
    500,
  );
  assert.doesNotMatch(handoff, /C:\\workspace\\jj-discord-bot/);
  assert.ok(handoff.length < 600);

  const publicReply = limitCodexDiscordResponse("y".repeat(3_000));
  assert.ok(publicReply.length <= 1_200);
  assert.match(publicReply, /Summary truncated/);
});
