import assert from "node:assert/strict";
import test from "node:test";
import {
  isBlockedAuthor,
  isAudioModeAuthorized,
  isCodexAuthorized,
  isEscalationAuthorized,
  isImageGenerationAuthorized,
  isWebAuthorized,
  compactCodexHandoff,
  compileImagePrompt,
  limitCodexDiscordResponse,
  normalizeCompiledImagePrompt,
  parseAudioModeCommand,
  parseEscalationCommand,
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
  assert.equal(requestsWebTools("@JJ busca noticias actuales"), true);
  assert.equal(requestsWebTools("@JJ fetch https://example.com"), true);
  assert.equal(requestsWebTools("@JJ resume https://example.com"), true);
  assert.equal(requestsWebTools("@JJ qué opinas de este enlace https://example.com"), false);
  assert.equal(requestsWebTools("@JJ cuéntame un chiste"), false);
});

test("parses supported escalation command forms", () => {
  assert.deepEqual(
    parseEscalationCommand("@JJ escalate to opus-5 :: review the architecture"),
    { requestedModel: "opus-5", task: "review the architecture" },
  );
  assert.deepEqual(
    parseEscalationCommand("@JJ escalate to Claude Opus 5 model and do identify two risks"),
    { requestedModel: "Claude Opus 5", task: "identify two risks" },
  );
  assert.deepEqual(
    parseEscalationCommand(
      "@JJ please escalate to kimi k3, read memory-improvements.md and write implementation plan. Advise when done.",
    ),
    {
      requestedModel: "kimi k3",
      task: "read memory-improvements.md and write implementation plan. Advise when done.",
    },
  );
  assert.equal(parseEscalationCommand("@JJ tell opus to do something"), null);
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
  assert.deepEqual(parseCodexDelegation("@JJ spawn codex :: inspect the project"), {
    task: "inspect the project",
  });
  assert.deepEqual(parseCodexDelegation("@JJ spawnea un codex para crear una demo"), {
    task: "crear una demo",
  });
  assert.deepEqual(
    parseCodexDelegation(
      "@JJ please spawn codex agent to assess memory-implementation-plan. Tell him to find selta-discord directory and cross the file with the codebase and advise if viable",
    ),
    {
      task:
        "assess memory-implementation-plan. Tell him to find selta-discord directory and cross the file with the codebase and advise if viable",
    },
  );
  assert.equal(parseCodexDelegation("@JJ qué opinas de Codex"), null);
  assert.equal(isCodexAuthorized({ id: "999", username: "OWNER_USER" }, config), true);
  assert.equal(isCodexAuthorized({ id: "999", username: "goblin" }, config), false);
});

test("parses owner-only audio mode toggles in Spanish and English", () => {
  const config = {
    audioAllowedUserIds: new Set(["123"]),
    audioAllowedUsernames: new Set(["owner_user"]),
  };
  assert.equal(parseAudioModeCommand("@JJ activa audio mode"), true);
  assert.equal(parseAudioModeCommand("@JJ enable audio mode"), true);
  assert.equal(parseAudioModeCommand("@JJ desactiva audio mode"), false);
  assert.equal(parseAudioModeCommand("@JJ disable audio mode"), false);
  assert.equal(parseAudioModeCommand("@JJ qué opinas del audio mode"), null);
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
  assert.deepEqual(parseImageGenerationCommand("@JJ draw a picture of a robot detective"), {
    prompt: "a robot detective",
    requestedModel: null,
  });
  assert.deepEqual(parseImageGenerationCommand("@JJ generate an image"), {
    prompt: null,
    requestedModel: null,
  });
  assert.deepEqual(
    parseImageGenerationCommand("@JJ draw a picture of the current situation"),
    {
      prompt: null,
      requestedModel: null,
    },
  );
  assert.deepEqual(
    parseImageGenerationCommand("@JJ generate an image of what is happening in cyberpunk style"),
    {
      prompt: null,
      requestedModel: null,
    },
  );
  assert.deepEqual(
    parseImageGenerationCommand("@JJ dibuja una imagen de la situaci\u00f3n actual"),
    {
      prompt: null,
      requestedModel: null,
    },
  );
  assert.deepEqual(
    parseImageGenerationCommand(
      "@JJ generate an image using model nano-banana-2-lite :: a goblin debugging production",
    ),
    {
      prompt: "a goblin debugging production",
      requestedModel: "nano-banana-2-lite",
    },
  );
  assert.deepEqual(
    parseImageGenerationCommand(
      "@JJ create an image with model ideogram/v4/fast :: a technical poster",
    ),
    {
      prompt: "a technical poster",
      requestedModel: "ideogram/v4/fast",
    },
  );
  assert.deepEqual(parseImageGenerationCommand("@JJ genera una imagen de lo que quieras"), {
    prompt: null,
    requestedModel: null,
  });
  assert.equal(parseImageGenerationCommand("@JJ describe this image"), null);
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
    { role: "user", content: "@JJ draw a goblin engineer" },
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
    reasoningEffort: "low",
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
