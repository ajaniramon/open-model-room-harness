import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ChannelType } from "discord.js";
import { startMcpControlServer } from "../src/mcp-control-server.js";

function createTestServer(overrides = {}) {
  return startMcpControlServer({
    config: {
      chatModel: "test-model",
      chatProvider: "test-provider",
      mcpControl: {
        enabled: true,
        host: "127.0.0.1",
        port: 0,
        bearerToken: "secret-token",
      },
      ...overrides.config,
    },
    behaviorModeController: {
      enabled: true,
      resolve: () => ({ mode: "manual" }),
      list: () => [],
      ...overrides.behaviorModeController,
    },
    runtimeControl: overrides.runtimeControl,
    participationController: overrides.participationController,
    memoryStore: overrides.memoryStore,
    memoryDigester: overrides.memoryDigester,
    audioModeState: overrides.audioModeState,
    audioConfigured: overrides.audioConfigured,
    chatRelay: overrides.chatRelay,
    discordClient: overrides.discordClient,
    auditLogger: overrides.auditLogger,
    logger: { info: () => undefined, error: () => undefined },
  });
}

async function callTool(port, name, args = {}) {
  const response = await fetch(`http://127.0.0.1:${port}/sse?access_token=secret-token`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  assert.equal(response.status, 200);
  const body = await response.text();
  const line = body.split("\n").find((entry) => entry.startsWith("data: "));
  assert.ok(line, `expected SSE data line in ${body}`);
  return JSON.parse(line.slice("data: ".length));
}

test("MCP control server requires bearer auth", async () => {
  const server = createTestServer();
  try {
    await new Promise((resolve) => setTimeout(resolve, 25));
    const { port } = server.address();
    const baseUrl = `http://127.0.0.1:${port}/health`;

    const rejected = await fetch(baseUrl);
    assert.equal(rejected.status, 401);

    const accepted = await fetch(baseUrl, {
      headers: { authorization: "Bearer secret-token" },
    });
    assert.equal(accepted.status, 200);
    assert.deepEqual(await accepted.json(), { ok: true });
  } finally {
    await server.close();
  }
});

test("MCP control server can authorize SSE sessions with a URL token", async () => {
  const server = createTestServer();
  try {
    await new Promise((resolve) => setTimeout(resolve, 25));
    const { port } = server.address();

    const accepted = await fetch(`http://127.0.0.1:${port}/health?access_token=secret-token`);
    assert.equal(accepted.status, 200);

    const rejected = await fetch(`http://127.0.0.1:${port}/health?access_token=wrong`);
    assert.equal(rejected.status, 401);
  } finally {
    await server.close();
  }
});

test("MCP control server accepts streamable HTTP posts on the configured URL", async () => {
  const server = createTestServer();
  try {
    await new Promise((resolve) => setTimeout(resolve, 25));
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/sse?access_token=secret-token`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test-client", version: "1.0.0" },
        },
      }),
    });
    assert.notEqual(response.status, 401);
    assert.notEqual(response.status, 404);
  } finally {
    await server.close();
  }
});

test("MCP control server accepts token-in-path streamable HTTP URLs", async () => {
  const server = createTestServer();
  try {
    await new Promise((resolve) => setTimeout(resolve, 25));
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/token/secret-token/sse`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test-client", version: "1.0.0" },
        },
      }),
    });
    assert.notEqual(response.status, 401);
    assert.notEqual(response.status, 404);
  } finally {
    await server.close();
  }
});

test("MCP runtime status includes participation availability", async () => {
  const server = createTestServer({
    participationController: {
      policy: { enabled: true },
      formatStatus: () => "Participation limits enabled",
    },
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 25));
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/sse?access_token=secret-token`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "get_participation_policy", arguments: {} },
      }),
    });
    assert.notEqual(response.status, 401);
    assert.notEqual(response.status, 404);
  } finally {
    await server.close();
  }
});

test("MCP control server accepts runtime control tool surface", async () => {
  const calls = [];
  const server = createTestServer({
    runtimeControl: {
      maintenanceEnabled: false,
      observationEnabled: false,
      execute: async (command) => {
        calls.push(command.action);
        return { response: `[${command.action}]` };
      },
    },
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 25));
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/sse?access_token=secret-token`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }),
    });
    assert.notEqual(response.status, 401);
    assert.notEqual(response.status, 404);
  } finally {
    await server.close();
  }
  assert.deepEqual(calls, []);
});

test("MCP control server accepts memory control tool surface", async () => {
  const server = createTestServer({
    memoryStore: { active: () => [{ id: "record-1", text: "private note" }] },
    memoryDigester: { capturing: () => false },
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 25));
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/sse?access_token=secret-token`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }),
    });
    assert.notEqual(response.status, 401);
    assert.notEqual(response.status, 404);
  } finally {
    await server.close();
  }
});

test("MCP control server can toggle audio mode", async () => {
  const audioModeState = {
    enabled: false,
    async set(enabled) {
      this.enabled = enabled === true;
      return this.enabled;
    },
  };
  const server = createTestServer({ audioModeState, audioConfigured: true });
  try {
    await new Promise((resolve) => setTimeout(resolve, 25));
    const { port } = server.address();
    const result = await callTool(port, "set_audio_mode", { enabled: true });
    const payload = JSON.parse(result.result.content[0].text);
    assert.equal(audioModeState.enabled, true);
    assert.deepEqual(payload, {
      enabled: true,
      ttsConfigured: true,
      warning: null,
    });
  } finally {
    await server.close();
  }
});

test("MCP control server exposes safe capability status", async () => {
  const server = createTestServer({
    config: {
      tavilyApiKey: "configured",
      nanoGptApiKey: "",
      memoryEnabled: true,
      memoryExtractionEnabled: false,
      xPrefetchEnabled: true,
      chatRelay: { enabled: true },
      discordEmojiPalette: ["<:one:1>", "<:two:2>"],
      codexExecutable: "codex",
      ownerUserIds: new Set(["owner-1"]),
      ownerUsernames: new Set(),
      allowedChannelIds: new Set(["channel-1", "channel-2"]),
      webAllowedUserIds: new Set(),
      webAllowedUsernames: new Set(["owner"]),
      audioAllowedUserIds: new Set(),
      audioAllowedUsernames: new Set(),
      imageAllowedUserIds: new Set(),
      imageAllowedUsernames: new Set(),
      codexAllowedUserIds: new Set(["owner-1"]),
      codexAllowedUsernames: new Set(),
    },
    participationController: {
      policy: { enabled: true },
      formatStatus: () => "Participation limits enabled",
    },
    memoryStore: { active: () => [] },
    chatRelay: { enabled: true, size: 0 },
    audioModeState: {
      enabled: false,
      async set(enabled) {
        this.enabled = enabled === true;
      },
    },
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 25));
    const { port } = server.address();
    const result = await callTool(port, "get_capability_status");
    const payload = JSON.parse(result.result.content[0].text);
    assert.equal(payload.tools.webConfigured, true);
    assert.equal(payload.tools.imageConfigured, false);
    assert.equal(payload.tools.codexConfigured, true);
    assert.equal(payload.permissions.owners, 1);
    assert.equal(payload.permissions.allowedChannels, 2);
    assert.equal(payload.memory.activeRecords, 0);
    assert.equal(payload.discord.emojiPaletteSize, 2);
    assert.equal(payload.chatRelay.enabled, true);
  } finally {
    await server.close();
  }
});

test("MCP control server can DM only a configured owner", async () => {
  const sent = [];
  const audits = [];
  const users = new Map([
    ["owner-1", {
      id: "owner-1",
      send: async (message) => {
        sent.push(["owner-1", message]);
      },
    }],
    ["stranger-1", {
      id: "stranger-1",
      send: async (message) => {
        sent.push(["stranger-1", message]);
      },
    }],
  ]);
  const discordClient = {
    isReady: () => true,
    user: { id: "bot-1", username: "bot", tag: "bot#0001" },
    guilds: { cache: new Map() },
    users: {
      cache: users,
      fetch: async (id) => users.get(id) || null,
    },
  };
  const server = createTestServer({
    config: {
      ownerUserIds: new Set(["owner-1"]),
      ownerUsernames: new Set(),
    },
    discordClient,
    auditLogger: {
      log: async (event) => audits.push(event),
    },
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 25));
    const { port } = server.address();
    const accepted = JSON.parse(
      (await callTool(port, "send_owner_dm", { message: "hello owner" }))
        .result.content[0].text,
    );
    assert.equal(accepted.ok, true);
    assert.deepEqual(sent, [["owner-1", "hello owner"]]);

    const rejected = JSON.parse(
      (await callTool(port, "send_owner_dm", {
        ownerUserId: "stranger-1",
        message: "hello stranger",
      })).result.content[0].text,
    );
    assert.equal(rejected.ok, false);
    assert.equal(sent.length, 1);
    assert.deepEqual(
      audits.map((event) => ({
        type: event.type,
        tool: event.tool,
        status: event.status,
        ownerUserId: event.ownerUserId,
        messageLength: event.messageLength,
        hasMessageBody: Object.hasOwn(event, "message"),
      })),
      [
        {
          type: "mcp_owner_dm",
          tool: "send_owner_dm",
          status: "sent",
          ownerUserId: "owner-1",
          messageLength: "hello owner".length,
          hasMessageBody: false,
        },
        {
          type: "mcp_owner_dm",
          tool: "send_owner_dm",
          status: "rejected",
          ownerUserId: null,
          messageLength: "hello stranger".length,
          hasMessageBody: false,
        },
      ],
    );
  } finally {
    await server.close();
  }
});

test("MCP control server creates scopes and sends only inside them", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mcp-scopes-"));
  const configPath = join(directory, "config.json");
  const sent = [];
  const audits = [];
  const channels = new Map([
    ["channel-1", {
      id: "channel-1",
      name: "public-chat",
      type: ChannelType.GuildText,
      guildId: "guild-1",
      parentId: null,
      permissionsFor: () => ({ has: () => true }),
      send: async (payload) => {
        sent.push(payload);
        return { id: "message-1" };
      },
    }],
    ["channel-2", {
      id: "channel-2",
      name: "elsewhere",
      type: ChannelType.GuildText,
      guildId: "guild-1",
      parentId: null,
      permissionsFor: () => ({ has: () => true }),
      send: async (payload) => {
        sent.push(payload);
        return { id: "message-2" };
      },
    }],
  ]);
  const discordClient = {
    isReady: () => true,
    user: { id: "bot-1", username: "bot", tag: "bot#0001" },
    guilds: { cache: new Map() },
    users: { cache: new Map(), fetch: async () => null },
    channels: {
      cache: channels,
      fetch: async (id) => channels.get(id) || null,
    },
  };
  const server = createTestServer({
    config: {
      configPath,
      discordScopes: {},
    },
    discordClient,
    auditLogger: {
      log: async (event) => audits.push(event),
    },
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 25));
    const { port } = server.address();
    const created = JSON.parse(
      (await callTool(port, "set_discord_scope", {
        scope: "publicChat",
        label: "Public Chat",
        guildIds: ["guild-1"],
        channelIds: ["channel-1"],
        allowSend: true,
      })).result.content[0].text,
    );
    assert.equal(created.name, "publicChat");
    assert.equal(created.defaultChannelId, "channel-1");

    const listed = JSON.parse(
      (await callTool(port, "list_discord_scopes")).result.content[0].text,
    );
    assert.equal(listed.total, 1);

    const accepted = JSON.parse(
      (await callTool(port, "send_scoped_discord_message", {
        scope: "publicChat",
        message: "@everyone hello",
      })).result.content[0].text,
    );
    assert.equal(accepted.ok, true);
    assert.deepEqual(sent, [{
      content: "@everyone hello",
      allowedMentions: { parse: [], repliedUser: false },
    }]);

    const rejected = JSON.parse(
      (await callTool(port, "send_scoped_discord_message", {
        scope: "publicChat",
        channelId: "channel-2",
        message: "not here",
      })).result.content[0].text,
    );
    assert.equal(rejected.ok, false);
    assert.equal(sent.length, 1);

    const guildWide = JSON.parse(
      (await callTool(port, "set_discord_scope", {
        scope: "guildWide",
        guildIds: ["guild-1"],
        allowSend: true,
      })).result.content[0].text,
    );
    assert.equal(guildWide.name, "guildWide");
    const guildAccepted = JSON.parse(
      (await callTool(port, "send_scoped_discord_message", {
        scope: "guildWide",
        channelId: "channel-2",
        message: "guild announcement",
      })).result.content[0].text,
    );
    assert.equal(guildAccepted.ok, true);
    assert.equal(sent.length, 2);
    assert.deepEqual(
      audits
        .filter((event) => event.type === "mcp_scoped_discord_send")
        .map((event) => [event.status, event.channelId, event.messageLength, Object.hasOwn(event, "message")]),
      [
        ["sent", "channel-1", "@everyone hello".length, false],
        ["rejected", "channel-2", "not here".length, false],
        ["sent", "channel-2", "guild announcement".length, false],
      ],
    );
  } finally {
    await server.close();
  }
});

test("MCP control server exposes an authenticated Discord scope editor API", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mcp-scope-panel-"));
  const configPath = join(directory, "config.json");
  const channels = new Map([
    ["channel-1", {
      id: "channel-1",
      name: "general",
      type: ChannelType.GuildText,
      parentId: null,
      rawPosition: 1,
      permissionsFor: () => ({ has: () => true }),
    }],
  ]);
  const guild = {
    id: "guild-1",
    name: "Guild One",
    available: true,
    memberCount: 7,
    channels: {
      cache: channels,
      fetch: async () => channels,
    },
  };
  const discordClient = {
    isReady: () => true,
    user: { id: "bot-1", username: "bot", tag: "bot#0001" },
    guilds: {
      cache: new Map([["guild-1", guild]]),
      fetch: async () => guild,
    },
  };
  const server = createTestServer({
    config: {
      configPath,
      discordScopes: {},
    },
    discordClient,
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 25));
    const { port } = server.address();
    const unauthorized = await fetch(`http://127.0.0.1:${port}/scopes`);
    assert.equal(unauthorized.status, 401);

    const page = await fetch(`http://127.0.0.1:${port}/scopes?access_token=secret-token`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Discord Scopes/);

    const saved = await fetch(`http://127.0.0.1:${port}/api/discord-scopes/lounge?access_token=secret-token`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        guildIds: ["guild-1"],
        channelIds: ["channel-1"],
        allowSend: true,
      }),
    });
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).scope.defaultChannelId, "channel-1");

    const scopes = await fetch(`http://127.0.0.1:${port}/api/discord-scopes?access_token=secret-token`);
    assert.equal(scopes.status, 200);
    assert.equal((await scopes.json()).total, 1);

    const guilds = await fetch(`http://127.0.0.1:${port}/api/discord-guilds?access_token=secret-token`);
    assert.equal((await guilds.json()).guilds[0].name, "Guild One");

    const listedChannels = await fetch(`http://127.0.0.1:${port}/api/discord-guilds/guild-1/channels?access_token=secret-token`);
    assert.equal((await listedChannels.json()).channels[0].id, "channel-1");
  } finally {
    await server.close();
  }
});

test("MCP control server exposes tool discovery metadata", async () => {
  const server = createTestServer();
  try {
    await new Promise((resolve) => setTimeout(resolve, 25));
    const { port } = server.address();
    const discovered = JSON.parse(
      (await callTool(port, "discover_mcp_tools", {
        category: "chat-relay",
        includeArguments: true,
      })).result.content[0].text,
    );
    assert.equal(discovered.total, 7);
    assert.ok(discovered.categories.includes("discovery"));
    assert.deepEqual(
      discovered.tools.map((tool) => tool.name),
      [
        "get_pending_chat_relay",
        "claim_chat_relay_items",
        "get_chat_relay_item",
        "submit_chat_relay_reply",
        "renew_chat_relay_lease",
        "complete_chat_relay_item",
        "dismiss_chat_relay_item",
      ],
    );
    assert.equal(discovered.tools[0].arguments.includeContext, "When true, include compacted Discord context.");

    const described = JSON.parse(
      (await callTool(port, "describe_mcp_tool", {
        name: "submit_chat_relay_reply",
      })).result.content[0].text,
    );
    assert.equal(described.category, "chat-relay");
    assert.equal(described.safety, "runtime-write");

    const missing = JSON.parse(
      (await callTool(port, "describe_mcp_tool", {
        name: "missing_tool",
      })).result.content[0].text,
    );
    assert.equal(missing, null);
  } finally {
    await server.close();
  }
});

test("MCP control server exposes Discord guild and channel discovery", async () => {
  const members = new Map([
    ["user-1", {
      displayName: "Server Name",
      user: {
        id: "user-1",
        username: "handle_one",
        globalName: "Global One",
        bot: false,
      },
    }],
    ["bot-2", {
      displayName: "Helper Bot",
      user: {
        id: "bot-2",
        username: "helper_bot",
        globalName: null,
        bot: true,
      },
    }],
  ]);
  const channels = new Map([
    ["category-1", {
      id: "category-1",
      name: "Meta",
      type: ChannelType.GuildCategory,
      parentId: null,
      rawPosition: 0,
      permissionsFor: () => ({ has: () => true }),
    }],
    ["channel-1", {
      id: "channel-1",
      name: "general",
      type: ChannelType.GuildText,
      parentId: "category-1",
      rawPosition: 1,
      permissionsFor: () => ({ has: () => true }),
    }],
    ["voice-1", {
      id: "voice-1",
      name: "voice",
      type: ChannelType.GuildVoice,
      parentId: null,
      rawPosition: 2,
      permissionsFor: () => ({ has: () => true }),
    }],
  ]);
  const guild = {
    id: "guild-1",
    name: "Test Guild",
    available: true,
    memberCount: 42,
    channels: {
      cache: channels,
      fetch: async () => channels,
    },
    members: {
      cache: members,
      fetch: async (input) => {
        if (typeof input === "string") return members.get(input) || null;
        const query = String(input?.query || "").toLowerCase();
        return new Map([...members].filter(([, member]) =>
          member.displayName.toLowerCase().includes(query) ||
          member.user.username.toLowerCase().includes(query)));
      },
    },
  };
  const discordClient = {
    isReady: () => true,
    user: { id: "bot-1", username: "bot", tag: "bot#0001" },
    guilds: {
      cache: new Map([["guild-1", guild]]),
      fetch: async () => guild,
    },
  };
  const server = createTestServer({ discordClient });
  try {
    await new Promise((resolve) => setTimeout(resolve, 25));
    const { port } = server.address();
    const status = JSON.parse(
      (await callTool(port, "get_discord_connection_status")).result.content[0].text,
    );
    assert.equal(status.ready, true);
    assert.equal(status.user.id, "bot-1");

    const guilds = JSON.parse(
      (await callTool(port, "list_discord_guilds")).result.content[0].text,
    );
    assert.equal(guilds.total, 1);
    assert.equal(guilds.guilds[0].id, "guild-1");

    const textChannels = JSON.parse(
      (await callTool(port, "list_discord_channels", { guildId: "guild-1" }))
        .result.content[0].text,
    );
    assert.equal(textChannels.total, 1);
    assert.equal(textChannels.channels[0].id, "channel-1");
    assert.equal(textChannels.channels[0].sendable, true);

    const allChannels = JSON.parse(
      (await callTool(port, "list_discord_channels", {
        guildId: "guild-1",
        includeUnsupported: true,
      })).result.content[0].text,
    );
    assert.equal(allChannels.total, 3);

    const resolvedMembers = JSON.parse(
      (await callTool(port, "resolve_discord_members", {
        guildId: "guild-1",
        userIds: ["user-1", "missing"],
      })).result.content[0].text,
    );
    assert.equal(resolvedMembers.members[0].member.displayName, "Server Name");
    assert.equal(resolvedMembers.members[1].found, false);

    const searchedMembers = JSON.parse(
      (await callTool(port, "search_discord_members", {
        guildId: "guild-1",
        query: "server",
      })).result.content[0].text,
    );
    assert.equal(searchedMembers.total, 1);
    assert.equal(searchedMembers.members[0].username, "handle_one");
  } finally {
    await server.close();
  }
});

test("MCP control server exposes a usage guide", async () => {
  const server = createTestServer();
  try {
    await new Promise((resolve) => setTimeout(resolve, 25));
    const { port } = server.address();
    const guide = JSON.parse(
      (await callTool(port, "get_mcp_usage_guide")).result.content[0].text,
    );
    assert.ok(guide.categories.includes("behavior"));
    assert.ok(guide.commonWorkflows.some((workflow) =>
      workflow.tools.includes("discover_mcp_tools")));
  } finally {
    await server.close();
  }
});

test("MCP control server can inspect and submit chat relay items", async () => {
  const calls = [];
  const chatRelay = {
    enabled: true,
    size: 1,
    pending: () => [{ id: "relay-1", triggerText: "hello" }],
    claim: async (args) => {
      calls.push(["claim", args.workerId, args.limit]);
      return [{ id: "relay-1", leaseToken: "lease-1" }];
    },
    get: () => ({ id: "relay-1", context: [{ role: "user", content: "hello" }] }),
    submit: async (id, reply, leaseToken) => {
      calls.push(["submit", id, reply, leaseToken]);
      return { ok: true, id };
    },
    renewLease: async (id, leaseToken) => {
      calls.push(["renew", id, leaseToken]);
      return { ok: true, id };
    },
    dismiss: async (id, reason, leaseToken) => {
      calls.push(["dismiss", id, reason, leaseToken]);
      return { ok: true, id };
    },
  };
  const server = createTestServer({ chatRelay });
  try {
    await new Promise((resolve) => setTimeout(resolve, 25));
    const { port } = server.address();
    const pending = JSON.parse(
      (await callTool(port, "get_pending_chat_relay")).result.content[0].text,
    );
    assert.equal(pending[0].id, "relay-1");
    await callTool(port, "claim_chat_relay_items", { workerId: "test-worker", limit: 1 });
    const item = JSON.parse(
      (await callTool(port, "get_chat_relay_item", { id: "relay-1" })).result.content[0].text,
    );
    assert.equal(item.context[0].content, "hello");
    await callTool(port, "submit_chat_relay_reply", { id: "relay-1", reply: "hi", leaseToken: "lease-1" });
    await callTool(port, "renew_chat_relay_lease", { id: "relay-1", leaseToken: "lease-1" });
    await callTool(port, "dismiss_chat_relay_item", { id: "relay-1", reason: "skip", leaseToken: "lease-1" });
    assert.deepEqual(calls, [
      ["claim", "test-worker", 1],
      ["submit", "relay-1", "hi", "lease-1"],
      ["renew", "relay-1", "lease-1"],
      ["dismiss", "relay-1", "skip", "lease-1"],
    ]);
  } finally {
    await server.close();
  }
});

test("MCP control server refuses to start without a token", () => {
  assert.throws(
    () =>
      startMcpControlServer({
        config: {
          mcpControl: { enabled: true, host: "127.0.0.1", port: 0, bearerToken: "" },
        },
        behaviorModeController: { enabled: true },
      }),
    /MCP_CONTROL_BEARER_TOKEN/,
  );
});
