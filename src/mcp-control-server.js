import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import { ChannelType, PermissionsBitField } from "discord.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { fetchRelayImageAttachment } from "./chat-relay-attachments.js";
import {
  clearDiscordScope,
  listDiscordScopes,
  resolveDiscordScope,
  scopeAllowsChannel,
  setDiscordScope,
} from "./discord-scopes.js";

function textResult(value) {
  return {
    content: [
      {
        type: "text",
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
      },
    ],
  };
}

async function runMemoryDigest(memoryDigester, channelId, logger = console) {
  if (!memoryDigester) return "Passive memory capture is not configured.";
  if (!memoryDigester.capturing?.({ channelId })) {
    return "Nothing is being captured right now.";
  }
  try {
    const { captured, stored } = await memoryDigester.digestNow(channelId);
    if (!captured) return "Nothing captured in this channel yet.";
    return {
      captured,
      stored: stored.length,
      preview: stored.slice(0, 5).map((record) => record.text),
    };
  } catch (error) {
    logger.error("MCP memory digest failed", error);
    return "Memory digest failed; the error has been logged.";
  }
}

function parseBearer(header = "") {
  const match = /^Bearer\s+(.+)$/i.exec(String(header || "").trim());
  return match?.[1] || "";
}

function hasValidToken(req, url, token) {
  return (
    token &&
    (parseBearer(req.headers.authorization) === token ||
      url.searchParams.get("access_token") === token ||
      tokenFromPath(url.pathname) === token)
  );
}

function tokenFromPath(pathname) {
  const match = /^\/token\/([^/]+)\/(?:sse|mcp)$/.exec(pathname);
  return match ? decodeURIComponent(match[1]) : "";
}

function normalizedMcpPath(pathname) {
  const match = /^\/token\/[^/]+\/(sse|mcp)$/.exec(pathname);
  return match ? `/${match[1]}` : pathname;
}

function rejectUnauthorized(res) {
  res.writeHead(401, {
    "content-type": "application/json",
    "www-authenticate": 'Bearer realm="mcp-control"',
  });
  res.end(JSON.stringify({ error: "Unauthorized" }));
}

function sendJson(res, status, value) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

function sendHtml(res, status, value) {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  res.end(value);
}

async function readJsonBody(req, limitBytes = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw new Error("Request body is too large.");
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return raw ? JSON.parse(raw) : {};
}

function sizeOf(value) {
  return typeof value?.size === "number" ? value.size : null;
}

const DISCORD_CHANNEL_TYPE_LABELS = Object.freeze({
  [ChannelType.GuildText]: "text",
  [ChannelType.DM]: "dm",
  [ChannelType.GuildVoice]: "voice",
  [ChannelType.GroupDM]: "group-dm",
  [ChannelType.GuildCategory]: "category",
  [ChannelType.GuildAnnouncement]: "announcement",
  [ChannelType.AnnouncementThread]: "announcement-thread",
  [ChannelType.PublicThread]: "public-thread",
  [ChannelType.PrivateThread]: "private-thread",
  [ChannelType.GuildStageVoice]: "stage-voice",
  [ChannelType.GuildDirectory]: "directory",
  [ChannelType.GuildForum]: "forum",
  [ChannelType.GuildMedia]: "media",
});

const DISCORD_TEXT_CHANNEL_TYPES = new Set([
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.PublicThread,
  ChannelType.PrivateThread,
  ChannelType.AnnouncementThread,
  ChannelType.GuildForum,
  ChannelType.GuildMedia,
]);

const TOOL_CATALOG = Object.freeze([
  {
    name: "discover_mcp_tools",
    category: "discovery",
    safety: "read-only",
    description: "List the MCP control tools exposed by this server.",
    arguments: {
      category: "Optional category filter.",
      includeArguments: "When true, include argument summaries for each tool.",
    },
  },
  {
    name: "describe_mcp_tool",
    category: "discovery",
    safety: "read-only",
    description: "Describe one MCP control tool and its expected arguments.",
    arguments: {
      name: "Tool name to describe.",
    },
  },
  {
    name: "get_mcp_usage_guide",
    category: "discovery",
    safety: "read-only",
    description: "Get a short workflow guide for using this MCP control surface.",
    arguments: {},
  },
  {
    name: "get_behavior_mode",
    category: "behavior",
    safety: "read-only",
    description: "Get the resolved behavior mode for global, guild, or channel scope.",
    arguments: {
      guildId: "Optional Discord guild/server ID.",
      channelId: "Optional Discord channel ID. Channel scope wins over guild/global.",
    },
  },
  {
    name: "get_discord_connection_status",
    category: "discord",
    safety: "read-only",
    description: "Get safe Discord client status and bot identity.",
    arguments: {},
  },
  {
    name: "list_discord_guilds",
    category: "discord",
    safety: "read-only",
    description: "List Discord guilds/servers visible to the running bot.",
    arguments: {},
  },
  {
    name: "list_discord_channels",
    category: "discord",
    safety: "read-only",
    description: "List channels visible to the running bot in one guild/server.",
    arguments: {
      guildId: "Discord guild/server ID.",
      includeUnsupported: "When true, include non-text channel types too.",
    },
  },
  {
    name: "resolve_discord_members",
    category: "discord",
    safety: "read-only",
    description: "Resolve Discord user IDs to server display names in one guild/server.",
    arguments: {
      guildId: "Discord guild/server ID.",
      userIds: "Discord user IDs to resolve.",
    },
  },
  {
    name: "search_discord_members",
    category: "discord",
    safety: "read-only",
    description: "Search visible Discord members by server display name or username.",
    arguments: {
      guildId: "Discord guild/server ID.",
      query: "Name text to search for.",
      limit: "Maximum members to return, capped at 25.",
      includeBots: "When true, include bot users.",
    },
  },
  {
    name: "send_owner_dm",
    category: "discord",
    safety: "runtime-write",
    description: "Send a direct message only to a configured owner Discord user ID.",
    arguments: {
      message: "DM text to send to the configured owner.",
      ownerUserId: "Optional configured owner ID when more than one owner ID exists.",
    },
  },
  {
    name: "list_discord_scopes",
    category: "discord",
    safety: "read-only",
    description: "List configured Discord scopes used for scoped actions.",
    arguments: {},
  },
  {
    name: "set_discord_scope",
    category: "discord",
    safety: "runtime-write",
    description: "Create or update a named Discord scope in config.json.",
    arguments: {
      scope: "Scope name.",
      label: "Optional human-readable label.",
      guildIds: "Allowed Discord guild/server IDs.",
      channelIds: "Allowed Discord channel IDs.",
      defaultChannelId: "Default channel for scoped send.",
      allowSend: "Whether scoped send is allowed.",
      allowRelayReply: "Whether relay reply is allowed in this scope.",
      attentionMode: "all, mentions_only, name_match, or keywords.",
      names: "Names that trigger attention for name_match.",
      keywords: "Keywords that trigger attention for keywords mode.",
      includeRepliesToSelf: "Whether replies to the bot count as attention.",
    },
  },
  {
    name: "clear_discord_scope",
    category: "discord",
    safety: "runtime-write",
    description: "Remove a named Discord scope from config.json.",
    arguments: {
      scope: "Scope name.",
    },
  },
  {
    name: "send_scoped_discord_message",
    category: "discord",
    safety: "runtime-write",
    description: "Send a message only through a configured Discord scope.",
    arguments: {
      scope: "Configured scope name.",
      message: "Message text to send.",
      channelId: "Optional channel ID inside the scope; defaultChannelId is used otherwise.",
    },
  },
  {
    name: "set_behavior_mode",
    category: "behavior",
    safety: "runtime-write",
    description: "Set manual, observe, auto, or maintenance globally, for a guild, or for a channel.",
    arguments: {
      mode: "manual, observe, auto, or maintenance. quiet remains a legacy alias.",
      guildId: "Optional Discord guild/server ID.",
      channelId: "Optional Discord channel ID.",
      durationMinutes: "Optional expiry duration from now.",
      expiresAt: "Optional absolute expiry timestamp.",
      cooldownSeconds: "Optional auto-mode cooldown.",
      maxRepliesPerHour: "Optional auto-mode hourly cap.",
      reason: "Optional audit reason.",
    },
  },
  {
    name: "clear_behavior_mode",
    category: "behavior",
    safety: "runtime-write",
    description: "Clear the configured behavior-mode override for a scope.",
    arguments: {
      guildId: "Optional Discord guild/server ID.",
      channelId: "Optional Discord channel ID.",
    },
  },
  {
    name: "list_behavior_modes",
    category: "behavior",
    safety: "read-only",
    description: "List configured behavior-mode overrides.",
    arguments: {},
  },
  {
    name: "get_runtime_status",
    category: "runtime",
    safety: "read-only",
    description: "Get resolved behavior, maintenance, observation, audio, and model status.",
    arguments: {
      guildId: "Optional Discord guild/server ID.",
      channelId: "Optional Discord channel ID.",
    },
  },
  {
    name: "get_capability_status",
    category: "runtime",
    safety: "read-only",
    description: "Get a safe summary of configured runtime capabilities.",
    arguments: {},
  },
  {
    name: "set_maintenance_mode",
    category: "runtime",
    safety: "runtime-write",
    description: "Enable or disable global maintenance mode.",
    arguments: {
      enabled: "Boolean maintenance state.",
    },
  },
  {
    name: "set_observation_mode",
    category: "runtime",
    safety: "runtime-write",
    description: "Enable or disable global observation mode.",
    arguments: {
      enabled: "Boolean observation state.",
    },
  },
  {
    name: "restart_runtime",
    category: "runtime",
    safety: "runtime-write",
    description: "Request a supervised runtime restart when configured.",
    arguments: {},
  },
  {
    name: "get_participation_status",
    category: "participation",
    safety: "read-only",
    description: "Get the formatted participation policy status.",
    arguments: {
      guildId: "Optional Discord guild/server ID.",
    },
  },
  {
    name: "get_participation_policy",
    category: "participation",
    safety: "read-only",
    description: "Get the active participation policy JSON.",
    arguments: {},
  },
  {
    name: "set_participation_policy",
    category: "participation",
    safety: "runtime-write",
    description: "Set one validated participation policy value.",
    arguments: {
      path: "Policy path, such as budget.maxResponses.",
      value: "String, number, or boolean value.",
      guildId: "Optional Discord guild/server ID.",
    },
  },
  {
    name: "reset_participation_policy",
    category: "participation",
    safety: "runtime-write",
    description: "Reset participation limits to safe defaults.",
    arguments: {
      guildId: "Optional Discord guild/server ID.",
    },
  },
  {
    name: "unban_participant",
    category: "participation",
    safety: "runtime-write",
    description: "Remove a temporary participation block for a Discord user ID.",
    arguments: {
      guildId: "Discord guild/server ID.",
      userId: "Discord user ID.",
    },
  },
  {
    name: "get_memory_status",
    category: "memory",
    safety: "read-only",
    description: "Get safe memory subsystem status without dumping stored memories.",
    arguments: {},
  },
  {
    name: "run_memory_digest",
    category: "memory",
    safety: "runtime-write",
    description: "Force passive memory digestion for one channel.",
    arguments: {
      channelId: "Discord channel ID.",
    },
  },
  {
    name: "get_audio_mode",
    category: "audio",
    safety: "read-only",
    description: "Get the persisted audio reply mode state.",
    arguments: {},
  },
  {
    name: "set_audio_mode",
    category: "audio",
    safety: "runtime-write",
    description: "Enable or disable persisted audio reply mode.",
    arguments: {
      enabled: "Boolean audio mode state.",
    },
  },
  {
    name: "get_pending_chat_relay",
    category: "chat-relay",
    safety: "read-only",
    description: "Get pending Discord turns awaiting an external chat reply.",
    arguments: {
      includeContext: "When true, include compacted Discord context.",
    },
  },
  {
    name: "claim_chat_relay_items",
    category: "chat-relay",
    safety: "runtime-write",
    description: "Atomically claim pending Discord turns for one external chat worker.",
    arguments: {
      workerId: "Stable worker identity.",
      limit: "Maximum number of items to claim.",
      leaseSeconds: "How long the claim remains owned.",
      includeContext: "When true, include compacted Discord context.",
    },
  },
  {
    name: "get_chat_relay_item",
    category: "chat-relay",
    safety: "read-only",
    description: "Get one pending Discord relay item including context.",
    arguments: {
      id: "Relay item ID.",
    },
  },
  {
    name: "get_chat_relay_attachment",
    category: "chat-relay",
    safety: "read-only",
    description: "Fetch one image attached to a pending or leased Discord relay item.",
    arguments: {
      id: "Relay item ID.",
      index: "Zero-based image attachment index from the relay item.",
    },
  },
  {
    name: "submit_chat_relay_reply",
    category: "chat-relay",
    safety: "runtime-write",
    description: "Submit a reply for a pending Discord relay item.",
    arguments: {
      id: "Relay item ID.",
      reply: "Reply text to send through the Discord harness.",
      leaseToken: "Lease token returned by claim_chat_relay_items.",
    },
  },
  {
    name: "renew_chat_relay_lease",
    category: "chat-relay",
    safety: "runtime-write",
    description: "Extend ownership of a claimed Discord relay item.",
    arguments: {
      id: "Relay item ID.",
      leaseToken: "Lease token returned by claim_chat_relay_items.",
      leaseSeconds: "Additional lease duration.",
    },
  },
  {
    name: "complete_chat_relay_item",
    category: "chat-relay",
    safety: "runtime-write",
    description: "Complete a claimed Discord relay item by delivering a reply.",
    arguments: {
      id: "Relay item ID.",
      reply: "Reply text to send through the Discord harness.",
      leaseToken: "Lease token returned by claim_chat_relay_items.",
    },
  },
  {
    name: "dismiss_chat_relay_item",
    category: "chat-relay",
    safety: "runtime-write",
    description: "Dismiss a pending Discord relay item without replying.",
    arguments: {
      id: "Relay item ID.",
      reason: "Optional dismissal reason.",
      leaseToken: "Lease token returned by claim_chat_relay_items.",
    },
  },
]);

const TOOL_CATEGORIES = Object.freeze([...new Set(TOOL_CATALOG.map((tool) => tool.category))]);

function publicToolInfo(tool, { includeArguments = false } = {}) {
  const info = {
    name: tool.name,
    category: tool.category,
    safety: tool.safety,
    description: tool.description,
  };
  if (includeArguments) info.arguments = tool.arguments;
  return info;
}

function resolveDiscordClient(discordClient) {
  return typeof discordClient === "function" ? discordClient() : discordClient;
}

function resolveDiscordWatchdog(discordWatchdog) {
  return typeof discordWatchdog === "function" ? discordWatchdog() : discordWatchdog;
}

function discordReady(client) {
  return client?.isReady?.() === true || client?.readyAt instanceof Date;
}

function publicGuildInfo(guild) {
  return {
    id: guild.id,
    name: guild.name,
    available: guild.available ?? true,
    memberCount: guild.memberCount ?? null,
  };
}

function canSendInChannel(channel, client) {
  const permissions = channel?.permissionsFor?.(client?.user);
  if (!permissions) return null;
  return permissions.has(PermissionsBitField.Flags.ViewChannel) &&
    permissions.has(PermissionsBitField.Flags.SendMessages);
}

function publicChannelInfo(channel, client) {
  return {
    id: channel.id,
    name: channel.name || null,
    type: DISCORD_CHANNEL_TYPE_LABELS[channel.type] || String(channel.type),
    parentId: channel.parentId || null,
    position: channel.rawPosition ?? channel.position ?? null,
    sendable: canSendInChannel(channel, client),
  };
}

function publicMemberInfo(member) {
  const user = member?.user || member;
  if (!user?.id) return null;
  return {
    id: user.id,
    username: user.username || null,
    globalName: user.globalName || null,
    displayName: member?.displayName || user.globalName || user.username || null,
    bot: user.bot === true,
  };
}

function configuredOwnerIds(config) {
  return [...(config.ownerUserIds || [])].map((id) => String(id)).filter(Boolean);
}

function resolveOwnerDmTarget(config, ownerUserId = "") {
  const owners = configuredOwnerIds(config);
  if (!owners.length) {
    return { ok: false, error: "No immutable owner Discord user IDs are configured." };
  }
  const requested = String(ownerUserId || "").trim();
  if (requested) {
    if (!owners.includes(requested)) {
      return { ok: false, error: "ownerUserId is not a configured owner ID." };
    }
    return { ok: true, userId: requested };
  }
  if (owners.length !== 1) {
    return { ok: false, error: "Multiple owner IDs are configured; pass ownerUserId explicitly." };
  }
  return { ok: true, userId: owners[0] };
}

async function resolveGuild(client, guildId) {
  if (!discordReady(client)) return null;
  return client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
}

function createMcpServer({
  behaviorModeController,
  runtimeControl = null,
  participationController = null,
  memoryStore = null,
  memoryDigester = null,
  audioModeState = null,
  audioConfigured = false,
  chatRelay = null,
  discordClient = null,
  discordWatchdog = null,
  getDiscordScopes = () => config.discordScopes || {},
  updateDiscordScopes = () => undefined,
  auditLogger = null,
  requestRuntimeRestart = null,
  config,
  logger = console,
  fetchImplementation = fetch,
}) {
  const server = new McpServer({
    name: "behavior-mode-control",
    version: "1.0.0",
  });

  server.tool("discover_mcp_tools", "List the MCP control tools exposed by this server.", {
    category: z.enum(TOOL_CATEGORIES).optional(),
    includeArguments: z.boolean().optional(),
  }, async ({ category, includeArguments = false }) => {
    const tools = TOOL_CATALOG
      .filter((tool) => !category || tool.category === category)
      .map((tool) => publicToolInfo(tool, { includeArguments }));
    return textResult({
      total: tools.length,
      categories: TOOL_CATEGORIES,
      tools,
    });
  });

  server.tool("describe_mcp_tool", "Describe one MCP control tool and its expected arguments.", {
    name: z.string().min(1).max(120),
  }, async ({ name }) => {
    const tool = TOOL_CATALOG.find((entry) => entry.name === name);
    return textResult(tool ? publicToolInfo(tool, { includeArguments: true }) : null);
  });

  server.tool("get_mcp_usage_guide", "Get a short workflow guide for using this MCP control surface.", {}, async () =>
    textResult({
      summary: "Use discovery first, read current status second, then make the smallest scoped runtime change needed.",
      categories: TOOL_CATEGORIES,
      commonWorkflows: [
        {
          goal: "Inspect available controls",
          tools: ["discover_mcp_tools", "describe_mcp_tool", "get_capability_status"],
        },
        {
          goal: "Change behavior mode",
          tools: ["list_discord_guilds", "list_discord_channels", "get_behavior_mode", "set_behavior_mode"],
        },
        {
          goal: "Answer queued Discord turns through an external chat provider",
          tools: [
            "claim_chat_relay_items",
            "get_chat_relay_item",
            "get_chat_relay_attachment",
            "complete_chat_relay_item",
          ],
        },
      ],
      notes: [
        "Read-only tools do not modify runtime state.",
        "Runtime-write tools can affect live Discord behavior.",
        "Chat relay tools do not expose raw arbitrary Discord send access.",
      ],
    }));

  server.tool("get_discord_connection_status", "Get safe Discord client status and bot identity.", {}, async () => {
    const client = resolveDiscordClient(discordClient);
    const watchdog = resolveDiscordWatchdog(discordWatchdog);
    return textResult({
      configured: Boolean(client),
      ready: discordReady(client),
      user: client?.user
        ? {
            id: client.user.id,
            username: client.user.username,
            tag: client.user.tag,
          }
        : null,
      guilds: client?.guilds?.cache?.size ?? null,
      watchdog: watchdog?.status?.() || {
        enabled: false,
        started: false,
      },
    });
  });

  server.tool("list_discord_guilds", "List Discord guilds/servers visible to the running bot.", {}, async () => {
    const client = resolveDiscordClient(discordClient);
    if (!discordReady(client)) {
      return textResult({
        ready: false,
        guilds: [],
      });
    }
    const guilds = [...client.guilds.cache.values()]
      .map(publicGuildInfo)
      .sort((a, b) => a.name.localeCompare(b.name));
    return textResult({
      ready: true,
      total: guilds.length,
      guilds,
    });
  });

  server.tool("list_discord_channels", "List channels visible to the running bot in one guild/server.", {
    guildId: z.string().min(1),
    includeUnsupported: z.boolean().optional(),
  }, async ({ guildId, includeUnsupported = false }) => {
    const client = resolveDiscordClient(discordClient);
    if (!discordReady(client)) {
      return textResult({
        ready: false,
        guildId,
        channels: [],
      });
    }
    const guild = await resolveGuild(client, guildId);
    if (!guild) {
      return textResult({
        ready: true,
        guildId,
        error: "Guild not found or not visible to the bot.",
        channels: [],
      });
    }
    const channels = await guild.channels.fetch().catch(() => guild.channels.cache);
    const visibleChannels = [...channels.values()]
      .filter(Boolean)
      .filter((channel) => includeUnsupported || DISCORD_TEXT_CHANNEL_TYPES.has(channel.type))
      .map((channel) => publicChannelInfo(channel, client))
      .sort((a, b) => {
        const position = (a.position ?? 0) - (b.position ?? 0);
        return position || String(a.name || "").localeCompare(String(b.name || ""));
      });
    return textResult({
      ready: true,
      guild: publicGuildInfo(guild),
      total: visibleChannels.length,
      channels: visibleChannels,
    });
  });

  server.tool("resolve_discord_members", "Resolve Discord user IDs to server display names in one guild/server.", {
    guildId: z.string().min(1),
    userIds: z.array(z.string().min(1)).min(1).max(25),
  }, async ({ guildId, userIds }) => {
    const client = resolveDiscordClient(discordClient);
    if (!discordReady(client)) {
      return textResult({
        ready: false,
        guildId,
        members: [],
      });
    }
    const guild = await resolveGuild(client, guildId);
    if (!guild) {
      return textResult({
        ready: true,
        guildId,
        error: "Guild not found or not visible to the bot.",
        members: [],
      });
    }
    const members = [];
    for (const userId of [...new Set(userIds.map((id) => String(id)))]) {
      const member = guild.members.cache.get(userId) ||
        await guild.members.fetch(userId).catch(() => null);
      members.push({
        userId,
        found: Boolean(member),
        member: member ? publicMemberInfo(member) : null,
      });
    }
    return textResult({
      ready: true,
      guild: publicGuildInfo(guild),
      members,
    });
  });

  server.tool("search_discord_members", "Search visible Discord members by server display name or username.", {
    guildId: z.string().min(1),
    query: z.string().min(1).max(80),
    limit: z.number().int().min(1).max(25).optional(),
    includeBots: z.boolean().optional(),
  }, async ({ guildId, query, limit = 10, includeBots = false }) => {
    const client = resolveDiscordClient(discordClient);
    if (!discordReady(client)) {
      return textResult({
        ready: false,
        guildId,
        members: [],
      });
    }
    const guild = await resolveGuild(client, guildId);
    if (!guild) {
      return textResult({
        ready: true,
        guildId,
        error: "Guild not found or not visible to the bot.",
        members: [],
      });
    }
    const cappedLimit = Math.min(limit, 25);
    const fetched = await guild.members.fetch({ query, limit: cappedLimit }).catch(() => null);
    const source = fetched || guild.members.cache;
    const needle = query.toLowerCase();
    const members = [...source.values()]
      .map(publicMemberInfo)
      .filter(Boolean)
      .filter((member) => includeBots || !member.bot)
      .filter((member) =>
        [member.displayName, member.username, member.globalName]
          .filter(Boolean)
          .some((name) => String(name).toLowerCase().includes(needle)))
      .slice(0, cappedLimit);
    return textResult({
      ready: true,
      guild: publicGuildInfo(guild),
      total: members.length,
      members,
      note: fetched ? null : "Search used the local member cache because Discord member search was unavailable.",
    });
  });

  server.tool("send_owner_dm", "Send a direct message only to a configured owner Discord user ID.", {
    message: z.string().min(1).max(2_000),
    ownerUserId: z.string().optional(),
  }, async ({ message, ownerUserId = "" }) => {
    const messageLength = String(message || "").length;
    const audit = async (status, details = {}) => auditLogger?.log?.({
      type: "mcp_owner_dm",
      tool: "send_owner_dm",
      status,
      ownerUserId: details.ownerUserId || null,
      messageLength,
      error: details.error || null,
    });
    const client = resolveDiscordClient(discordClient);
    if (!discordReady(client)) {
      await audit("failed", { error: "discord_not_ready" });
      return textResult({
        ok: false,
        error: "Discord client is not ready.",
      });
    }
    const target = resolveOwnerDmTarget(config, ownerUserId);
    if (!target.ok) {
      await audit("rejected", { error: target.error });
      return textResult(target);
    }
    const user = client.users.cache.get(target.userId) ||
      await client.users.fetch(target.userId).catch(() => null);
    if (!user) {
      await audit("failed", { ownerUserId: target.userId, error: "owner_fetch_failed" });
      return textResult({
        ok: false,
        error: "Configured owner user could not be fetched.",
      });
    }
    try {
      await user.send(String(message));
    } catch (error) {
      logger.error("MCP owner DM failed", error);
      await audit("failed", { ownerUserId: target.userId, error: error?.name || "send_failed" });
      return textResult({
        ok: false,
        error: "Owner DM failed; the error has been logged.",
      });
    }
    await audit("sent", { ownerUserId: target.userId });
    return textResult({
      ok: true,
      userId: target.userId,
    });
  });

  server.tool("list_discord_scopes", "List configured Discord scopes used for scoped actions.", {}, async () =>
    textResult({
      total: listDiscordScopes(getDiscordScopes()).length,
      scopes: listDiscordScopes(getDiscordScopes()),
    }));

  server.tool("set_discord_scope", "Create or update a named Discord scope in config.json.", {
    scope: z.string().min(1).max(40),
    label: z.string().max(120).optional(),
    guildIds: z.array(z.string().min(1)).max(100).optional(),
    channelIds: z.array(z.string().min(1)).max(200).optional(),
    defaultChannelId: z.string().optional(),
    allowSend: z.boolean().optional(),
    allowRelayReply: z.boolean().optional(),
    attentionMode: z.enum(["all", "mentions_only", "name_match", "keywords"]).optional(),
    names: z.array(z.string().min(1).max(80)).max(25).optional(),
    keywords: z.array(z.string().min(1).max(80)).max(50).optional(),
    includeRepliesToSelf: z.boolean().optional(),
  }, async ({ scope, ...patch }) => {
    try {
      const saved = await setDiscordScope(config.configPath, getDiscordScopes(), scope, patch);
      const nextScopes = {
        ...getDiscordScopes(),
        [saved.name]: {
          label: saved.label,
          guildIds: saved.guildIds,
          channelIds: saved.channelIds,
          defaultChannelId: saved.defaultChannelId,
          allowSend: saved.allowSend,
          allowRelayReply: saved.allowRelayReply,
          attentionMode: saved.attentionMode,
          names: saved.names,
          keywords: saved.keywords,
          includeRepliesToSelf: saved.includeRepliesToSelf,
        },
      };
      updateDiscordScopes(nextScopes);
      await auditLogger?.log?.({
        type: "mcp_discord_scope_set",
        tool: "set_discord_scope",
        scope: saved.name,
        channelCount: saved.channelIds.length,
        guildCount: saved.guildIds.length,
        allowSend: saved.allowSend,
      });
      return textResult(saved);
    } catch (error) {
      return textResult({
        ok: false,
        error: error.message || String(error),
      });
    }
  });

  server.tool("clear_discord_scope", "Remove a named Discord scope from config.json.", {
    scope: z.string().min(1).max(40),
  }, async ({ scope }) => {
    try {
      const result = await clearDiscordScope(config.configPath, getDiscordScopes(), scope);
      const nextScopes = { ...getDiscordScopes() };
      delete nextScopes[result.name];
      updateDiscordScopes(nextScopes);
      await auditLogger?.log?.({
        type: "mcp_discord_scope_cleared",
        tool: "clear_discord_scope",
        scope: result.name,
        removed: result.removed,
      });
      return textResult(result);
    } catch (error) {
      return textResult({
        ok: false,
        error: error.message || String(error),
      });
    }
  });

  server.tool("send_scoped_discord_message", "Send a message only through a configured Discord scope.", {
    scope: z.string().min(1).max(40),
    message: z.string().min(1).max(2_000),
    channelId: z.string().optional(),
  }, async ({ scope, message, channelId = "" }) => {
    const audit = async (status, details = {}) => auditLogger?.log?.({
      type: "mcp_scoped_discord_send",
      tool: "send_scoped_discord_message",
      status,
      scope,
      channelId: details.channelId || channelId || null,
      messageLength: String(message || "").length,
      error: details.error || null,
    });
    const client = resolveDiscordClient(discordClient);
    if (!discordReady(client)) {
      await audit("failed", { error: "discord_not_ready" });
      return textResult({ ok: false, error: "Discord client is not ready." });
    }
    const configuredScope = resolveDiscordScope(getDiscordScopes(), scope);
    if (!configuredScope) {
      await audit("rejected", { error: "scope_not_found" });
      return textResult({ ok: false, error: "Scope not found." });
    }
    if (configuredScope.allowSend !== true) {
      await audit("rejected", { error: "send_not_allowed" });
      return textResult({ ok: false, error: "Scope does not allow sending." });
    }
    const targetChannelId = String(channelId || configuredScope.defaultChannelId || "").trim();
    if (!targetChannelId) {
      await audit("rejected", { error: "channel_required" });
      return textResult({ ok: false, error: "channelId is required because the scope has no defaultChannelId." });
    }
    const channel = client.channels.cache.get(targetChannelId) ||
      await client.channels.fetch(targetChannelId).catch(() => null);
    if (!channel) {
      await audit("failed", { channelId: targetChannelId, error: "channel_not_found" });
      return textResult({ ok: false, error: "Channel was not found or is not visible to the bot." });
    }
    if (!scopeAllowsChannel(configuredScope, {
      guildId: channel.guildId || null,
      channelId: channel.id,
      parentId: channel.parentId || null,
    })) {
      await audit("rejected", { channelId: targetChannelId, error: "channel_or_guild_not_in_scope" });
      return textResult({ ok: false, error: "Channel or guild is not in scope." });
    }
    if (!DISCORD_TEXT_CHANNEL_TYPES.has(channel.type) || typeof channel.send !== "function") {
      await audit("rejected", { channelId: targetChannelId, error: "unsupported_channel_type" });
      return textResult({ ok: false, error: "Scope send supports text-like Discord channels only." });
    }
    if (canSendInChannel(channel, client) !== true) {
      await audit("rejected", { channelId: targetChannelId, error: "missing_send_permission" });
      return textResult({ ok: false, error: "Bot lacks View Channel or Send Messages permission there." });
    }
    try {
      const sent = await channel.send({
        content: String(message),
        allowedMentions: { parse: [], repliedUser: false },
      });
      await audit("sent", { channelId: targetChannelId });
      return textResult({
        ok: true,
        scope: configuredScope.name,
        guildId: channel.guildId || null,
        channelId: targetChannelId,
        messageId: sent?.id || null,
      });
    } catch (error) {
      logger.error("MCP scoped Discord send failed", error);
      await audit("failed", { channelId: targetChannelId, error: error?.name || "send_failed" });
      return textResult({ ok: false, error: "Scoped Discord send failed; the error has been logged." });
    }
  });

  server.tool("get_behavior_mode", "Get the resolved behavior mode for a scope.", {
    guildId: z.string().optional(),
    channelId: z.string().optional(),
  }, async ({ guildId, channelId }) => textResult(
    behaviorModeController.resolve({ guildId, channelId }),
  ));

  server.tool("set_behavior_mode", "Set a behavior mode globally, for a guild, or for a channel.", {
    mode: z.enum(["manual", "observe", "auto", "maintenance", "quiet"]),
    guildId: z.string().optional(),
    channelId: z.string().optional(),
    durationMinutes: z.number().int().min(1).max(10_080).optional(),
    expiresAt: z.string().optional(),
    cooldownSeconds: z.number().int().min(0).max(86_400).optional(),
    maxRepliesPerHour: z.number().int().min(0).max(500).optional(),
    reason: z.string().max(500).optional(),
  }, async (args) => textResult(await behaviorModeController.setMode(args, {
    reason: args.reason,
    source: "mcp",
  })));

  server.tool("clear_behavior_mode", "Clear the configured behavior mode for a scope.", {
    guildId: z.string().optional(),
    channelId: z.string().optional(),
  }, async ({ guildId, channelId }) => textResult({
    removed: await behaviorModeController.clearMode({ guildId, channelId }, { source: "mcp" }),
  }));

  server.tool("list_behavior_modes", "List configured behavior mode overrides.", {}, async () =>
    textResult(behaviorModeController.list()));

  server.tool("get_runtime_status", "Get generic runtime control and behavior mode status.", {
    guildId: z.string().optional(),
    channelId: z.string().optional(),
  }, async ({ guildId, channelId }) => textResult({
    behaviorMode: behaviorModeController.resolve({ guildId, channelId }),
    maintenanceEnabled: runtimeControl?.maintenanceEnabled === true,
    observationEnabled: runtimeControl?.observationEnabled === true,
    audioModeEnabled: audioModeState?.enabled ?? null,
    audioConfigured: Boolean(audioConfigured),
    model: config.chatModel,
    provider: config.chatProvider,
  }));

  server.tool("get_capability_status", "Get a safe read-only summary of configured runtime capabilities.", {}, async () =>
    textResult({
      behaviorMode: {
        configured: Boolean(behaviorModeController),
        enabled: behaviorModeController?.enabled === true,
      },
      runtimeControl: {
        configured: Boolean(runtimeControl),
        maintenanceEnabled: runtimeControl?.maintenanceEnabled ?? null,
        observationEnabled: runtimeControl?.observationEnabled ?? null,
      },
      participation: {
        configured: Boolean(participationController),
        enabled: participationController?.policy?.enabled ?? null,
      },
      memory: {
        configured: Boolean(memoryStore),
        passiveCaptureConfigured: Boolean(memoryDigester),
        enabled: config.memoryEnabled ?? Boolean(memoryStore),
        extractionEnabled: config.memoryExtractionEnabled ?? Boolean(memoryDigester),
        activeRecords: memoryStore?.active?.().length ?? null,
      },
      audio: {
        configured: Boolean(audioModeState),
        enabled: audioModeState?.enabled ?? null,
        ttsConfigured: Boolean(audioConfigured),
      },
      model: {
        provider: config.chatProvider,
        model: config.chatModel,
      },
      chatRelay: {
        configured: Boolean(chatRelay),
        enabled: chatRelay?.enabled ?? false,
        pending: chatRelay?.size ?? null,
        oldestPendingAgeSeconds: chatRelay?.oldestPendingAgeSeconds?.() ?? null,
        leased: chatRelay?.leasedSize ?? null,
      },
      tools: {
        webConfigured: config.tavilyApiKey ? true : config.tavilyApiKey === "" ? false : null,
        imageConfigured: config.nanoGptApiKey ? true : config.nanoGptApiKey === "" ? false : null,
        codexConfigured: config.codexExecutable ? true : config.codexExecutable === "" ? false : null,
        xPrefetchEnabled: config.xPrefetchEnabled ?? null,
      },
      permissions: {
        owners: sizeOf(config.ownerUserIds) + sizeOf(config.ownerUsernames),
        allowedChannels: sizeOf(config.allowedChannelIds),
        webUsers: sizeOf(config.webAllowedUserIds) + sizeOf(config.webAllowedUsernames),
        audioUsers: sizeOf(config.audioAllowedUserIds) + sizeOf(config.audioAllowedUsernames),
        imageUsers: sizeOf(config.imageAllowedUserIds) + sizeOf(config.imageAllowedUsernames),
        codexUsers: sizeOf(config.codexAllowedUserIds) + sizeOf(config.codexAllowedUsernames),
      },
      discord: {
        emojiPaletteSize: Array.isArray(config.discordEmojiPalette)
          ? config.discordEmojiPalette.length
          : null,
      },
    }));

  server.tool("set_maintenance_mode", "Enable or disable global maintenance mode.", {
    enabled: z.boolean(),
  }, async ({ enabled }) => {
    if (!runtimeControl) return textResult("Runtime control is not configured.");
    const action = enabled ? "maintenance_on" : "maintenance_off";
    return textResult((await runtimeControl.execute({ action }, { source: "mcp" })).response);
  });

  server.tool("set_observation_mode", "Enable or disable global observation mode.", {
    enabled: z.boolean(),
  }, async ({ enabled }) => {
    if (!runtimeControl) return textResult("Runtime control is not configured.");
    const action = enabled ? "observation_on" : "observation_off";
    return textResult((await runtimeControl.execute({ action }, { source: "mcp" })).response);
  });

  server.tool("restart_runtime", "Request a supervised runtime restart when configured.", {}, async () => {
    if (!runtimeControl) return textResult("Runtime control is not configured.");
    const result = await runtimeControl.execute({ action: "restart" }, { source: "mcp" });
    if (result.restart) requestRuntimeRestart?.();
    return textResult(result.response);
  });

  server.tool("get_participation_status", "Get the formatted participation policy status.", {
    guildId: z.string().optional(),
  }, async ({ guildId }) => textResult(
    participationController
      ? participationController.formatStatus(guildId || null)
      : "Participation control is not configured.",
  ));

  server.tool("get_participation_policy", "Get the active participation policy JSON.", {}, async () =>
    textResult(participationController?.policy || null));

  server.tool("set_participation_policy", "Set one validated participation policy value.", {
    path: z.string().min(1).max(80),
    value: z.union([z.string(), z.number(), z.boolean()]),
    guildId: z.string().optional(),
  }, async ({ path, value, guildId }) => {
    if (!participationController) return textResult("Participation control is not configured.");
    return textResult(await participationController.executeAdminCommand(
      { action: "set", path, value: String(value) },
      { guildId: guildId || null },
    ));
  });

  server.tool("reset_participation_policy", "Reset participation limits to safe defaults.", {
    guildId: z.string().optional(),
  }, async ({ guildId }) => {
    if (!participationController) return textResult("Participation control is not configured.");
    return textResult(await participationController.executeAdminCommand(
      { action: "reset" },
      { guildId: guildId || null },
    ));
  });

  server.tool("unban_participant", "Remove a temporary participation block for a Discord user ID.", {
    guildId: z.string(),
    userId: z.string(),
  }, async ({ guildId, userId }) => {
    if (!participationController) return textResult("Participation control is not configured.");
    return textResult(await participationController.executeAdminCommand(
      { action: "unban", userId },
      { guildId },
    ));
  });

  server.tool("get_memory_status", "Get safe memory subsystem status without dumping stored memories.", {}, async () =>
    textResult({
      configured: Boolean(memoryStore),
      passiveCaptureConfigured: Boolean(memoryDigester),
      capturing: memoryDigester?.capturing?.() === true,
      activeRecords: memoryStore?.active?.().length ?? null,
    }));

  server.tool("run_memory_digest", "Force passive memory digestion for one channel.", {
    channelId: z.string(),
  }, async ({ channelId }) => textResult(await runMemoryDigest(memoryDigester, channelId, logger)));

  server.tool("get_audio_mode", "Get the persisted audio reply mode state.", {}, async () =>
    textResult({
      configured: Boolean(audioModeState),
      enabled: audioModeState?.enabled ?? null,
      ttsConfigured: Boolean(audioConfigured),
    }));

  server.tool("set_audio_mode", "Enable or disable persisted audio reply mode.", {
    enabled: z.boolean(),
  }, async ({ enabled }) => {
    if (!audioModeState) return textResult("Audio mode control is not configured.");
    await audioModeState.set(enabled);
    return textResult({
      enabled: audioModeState.enabled,
      ttsConfigured: Boolean(audioConfigured),
      warning: enabled && !audioConfigured
        ? "Audio mode was enabled, but this control process cannot verify text-to-speech configuration."
        : null,
    });
  });

  server.tool("get_pending_chat_relay", "Get pending Discord turns awaiting an external chat reply.", {
    includeContext: z.boolean().optional(),
  }, async ({ includeContext = false }) =>
    textResult(chatRelay?.pending?.({ includeContext }) || []));

  server.tool("claim_chat_relay_items", "Atomically claim pending Discord turns for an external chat worker.", {
    workerId: z.string().min(1).max(100),
    limit: z.number().int().min(1).max(50).optional(),
    leaseSeconds: z.number().int().min(10).max(3_600).optional(),
    includeContext: z.boolean().optional(),
  }, async ({ workerId, limit = 3, leaseSeconds, includeContext = true }) => textResult(
    chatRelay
      ? await chatRelay.claim({ workerId, limit, leaseSeconds, includeContext })
      : [],
  ));

  server.tool("get_chat_relay_item", "Get one pending Discord relay item including context.", {
    id: z.string(),
  }, async ({ id }) => textResult(chatRelay?.get?.(id, { includeContext: true }) || null));

  server.tool("get_chat_relay_attachment", "Fetch one image attached to a pending or leased Discord relay item.", {
    id: z.string(),
    index: z.number().int().min(0).max(9),
  }, async ({ id, index }) => {
    const reference = chatRelay?.getImageAttachment?.(id, index);
    if (!reference) {
      return {
        content: [{ type: "text", text: "Relay image attachment was not found or is no longer active." }],
        isError: true,
      };
    }
    try {
      const image = await fetchRelayImageAttachment(reference, {
        fetchImplementation,
        maxBytes: config.chatRelay?.maxAttachmentBytes,
      });
      return {
        content: [
          { type: "image", data: image.data, mimeType: image.mimeType },
          {
            type: "text",
            text: JSON.stringify({
              relayItemId: id,
              index,
              source: reference.source,
              filename: reference.filename,
              mimeType: image.mimeType,
              size: image.size,
            }),
          },
        ],
      };
    } catch (error) {
      logger.error("MCP chat relay attachment fetch failed", error);
      return {
        content: [{
          type: "text",
          text: error instanceof Error ? error.message : "Relay image attachment could not be fetched.",
        }],
        isError: true,
      };
    }
  });

  server.tool("submit_chat_relay_reply", "Submit a reply for a pending Discord relay item.", {
    id: z.string(),
    reply: z.string().min(1).max(8_000),
    leaseToken: z.string().optional(),
  }, async ({ id, reply, leaseToken }) =>
    textResult(chatRelay
      ? await chatRelay.submit(id, reply, leaseToken)
      : { ok: false, error: "Chat relay is not configured." }));

  server.tool("renew_chat_relay_lease", "Extend ownership of a claimed Discord relay item.", {
    id: z.string(),
    leaseToken: z.string().min(1),
    leaseSeconds: z.number().int().min(10).max(3_600).optional(),
  }, async ({ id, leaseToken, leaseSeconds }) => textResult(
    chatRelay
      ? await chatRelay.renewLease(id, leaseToken, leaseSeconds)
      : { ok: false, error: "Chat relay is not configured." },
  ));

  server.tool("complete_chat_relay_item", "Complete a claimed Discord relay item by delivering a reply.", {
    id: z.string(),
    reply: z.string().min(1).max(8_000),
    leaseToken: z.string().min(1),
  }, async ({ id, reply, leaseToken }) => textResult(
    chatRelay
      ? await chatRelay.submit(id, reply, leaseToken)
      : { ok: false, error: "Chat relay is not configured." },
  ));

  server.tool("dismiss_chat_relay_item", "Dismiss a pending Discord relay item without replying.", {
    id: z.string(),
    reason: z.string().max(500).optional(),
    leaseToken: z.string().optional(),
  }, async ({ id, reason = "", leaseToken }) =>
    textResult(chatRelay
      ? await chatRelay.dismiss(id, reason, leaseToken)
      : { ok: false, error: "Chat relay is not configured." }));

  return server;
}

export function startMcpControlServer({
  config,
  behaviorModeController,
  runtimeControl = null,
  participationController = null,
  memoryStore = null,
  memoryDigester = null,
  audioModeState = null,
  audioConfigured = false,
  chatRelay = null,
  discordClient = null,
  discordWatchdog = null,
  auditLogger = null,
  requestRuntimeRestart = null,
  logger = console,
  fetchImplementation = fetch,
}) {
  if (!config.mcpControl?.enabled) return null;
  if (!behaviorModeController?.enabled) {
    throw new Error("MCP control requires the unified behavior policy.");
  }
  const token = String(config.mcpControl.bearerToken || "").trim();
  if (!token) throw new Error("MCP control requires MCP_CONTROL_BEARER_TOKEN.");
  const wakeToken = String(config.mcpControl.wakeToken || "").trim();
  if (wakeToken && wakeToken === token) {
    throw new Error("MCP_CONTROL_WAKE_TOKEN must differ from MCP_CONTROL_BEARER_TOKEN.");
  }

  const transports = new Map();
  const authorizedSessions = new Set();
  let discordScopes = config.discordScopes || {};
  let scopePanelHtml = null;
  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
    const sessionId = url.searchParams.get("sessionId") || "";
    const path = normalizedMcpPath(url.pathname);
    const wakeStatusRequest = req.method === "GET" && path === "/api/chat-relay/wake-status";
    if (wakeStatusRequest && !wakeToken) {
      sendJson(res, 503, { error: "Wake status is not configured." });
      return;
    }
    const authorized =
      (wakeStatusRequest && hasValidToken(req, url, wakeToken)) ||
      (!wakeStatusRequest && (hasValidToken(req, url, token) || (sessionId && authorizedSessions.has(sessionId))));
    if (!authorized) {
      rejectUnauthorized(res);
      return;
    }
    try {
      if (wakeStatusRequest) {
        const status = chatRelay?.wakeStatus?.() || {
          pendingCount: 0,
          leasedCount: 0,
          activeCount: 0,
          pendingKey: "",
          activeKey: "",
          oldestPendingId: null,
          oldestActiveId: null,
        };
        sendJson(res, 200, {
          enabled: chatRelay?.enabled === true,
          ...status,
        });
        return;
      }

      if ((req.method === "GET" || req.method === "POST") && ["/mcp", "/sse"].includes(path)) {
        if (req.method === "POST") {
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
          });
          await createMcpServer({
            behaviorModeController,
            runtimeControl,
            participationController,
            memoryStore,
            memoryDigester,
            audioModeState,
            audioConfigured,
            chatRelay,
            discordClient,
            discordWatchdog,
            getDiscordScopes: () => discordScopes,
            updateDiscordScopes: (nextScopes) => {
              discordScopes = nextScopes;
            },
            auditLogger,
            requestRuntimeRestart,
            config,
            logger,
            fetchImplementation,
          }).connect(transport);
          await transport.handleRequest(req, res);
          return;
        }
        if (path === "/mcp") {
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
          });
          await createMcpServer({
            behaviorModeController,
            runtimeControl,
            participationController,
            memoryStore,
            memoryDigester,
            audioModeState,
            audioConfigured,
            chatRelay,
            discordClient,
            discordWatchdog,
            getDiscordScopes: () => discordScopes,
            updateDiscordScopes: (nextScopes) => {
              discordScopes = nextScopes;
            },
            auditLogger,
            requestRuntimeRestart,
            config,
            logger,
            fetchImplementation,
          }).connect(transport);
          await transport.handleRequest(req, res);
          return;
        }
      }

      if (req.method === "GET" && path === "/sse") {
        const transport = new SSEServerTransport("/messages", res);
        transports.set(transport.sessionId, transport);
        authorizedSessions.add(transport.sessionId);
        res.on("close", () => {
          transports.delete(transport.sessionId);
          authorizedSessions.delete(transport.sessionId);
        });
        await createMcpServer({
          behaviorModeController,
          runtimeControl,
          participationController,
          memoryStore,
          memoryDigester,
          audioModeState,
          audioConfigured,
          chatRelay,
          discordClient,
          discordWatchdog,
          getDiscordScopes: () => discordScopes,
          updateDiscordScopes: (nextScopes) => {
            discordScopes = nextScopes;
          },
          auditLogger,
          requestRuntimeRestart,
          config,
          logger,
          fetchImplementation,
        }).connect(transport);
        return;
      }

      if (req.method === "POST" && path === "/messages") {
        const transport = transports.get(sessionId);
        if (!transport) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "No active SSE session." }));
          return;
        }
        await transport.handlePostMessage(req, res);
        return;
      }

      if (req.method === "GET" && path === "/health") {
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === "GET" && path === "/scopes") {
        scopePanelHtml ||= await readFile(new URL("../scripts/discord-scopes-panel.html", import.meta.url), "utf8");
        sendHtml(res, 200, scopePanelHtml);
        return;
      }

      if (req.method === "GET" && path === "/api/discord-scopes") {
        sendJson(res, 200, {
          total: listDiscordScopes(discordScopes).length,
          scopes: listDiscordScopes(discordScopes),
        });
        return;
      }

      if (req.method === "PUT" && path.startsWith("/api/discord-scopes/")) {
        const scopeName = decodeURIComponent(path.slice("/api/discord-scopes/".length));
        const body = await readJsonBody(req);
        const saved = await setDiscordScope(config.configPath, discordScopes, scopeName, body);
        discordScopes = {
          ...discordScopes,
          [saved.name]: saved,
        };
        delete discordScopes[saved.name].name;
        auditLogger?.log?.({
          type: "http_discord_scope_set",
          tool: "scope_panel",
          status: "saved",
          scope: saved.name,
          channelCount: saved.channelIds.length,
          allowSend: saved.allowSend,
        });
        sendJson(res, 200, { ok: true, scope: saved });
        return;
      }

      if (req.method === "DELETE" && path.startsWith("/api/discord-scopes/")) {
        const scopeName = decodeURIComponent(path.slice("/api/discord-scopes/".length));
        const result = await clearDiscordScope(config.configPath, discordScopes, scopeName);
        const nextScopes = { ...discordScopes };
        delete nextScopes[result.name];
        discordScopes = nextScopes;
        auditLogger?.log?.({
          type: "http_discord_scope_cleared",
          tool: "scope_panel",
          status: result.removed ? "removed" : "not_found",
          scope: result.name,
        });
        sendJson(res, 200, { ok: true, ...result });
        return;
      }

      if (req.method === "GET" && path === "/api/discord-guilds") {
        const client = resolveDiscordClient(discordClient);
        if (!discordReady(client)) {
          sendJson(res, 200, { ready: false, guilds: [] });
          return;
        }
        const guilds = [...client.guilds.cache.values()]
          .map(publicGuildInfo)
          .sort((a, b) => a.name.localeCompare(b.name));
        sendJson(res, 200, { ready: true, total: guilds.length, guilds });
        return;
      }

      if (req.method === "GET" && path.startsWith("/api/discord-guilds/") && path.endsWith("/channels")) {
        const guildId = decodeURIComponent(path.slice("/api/discord-guilds/".length, -"/channels".length));
        const client = resolveDiscordClient(discordClient);
        const guild = await resolveGuild(client, guildId);
        if (!guild) {
          sendJson(res, 404, { ready: discordReady(client), error: "Guild not found or Discord client is not ready." });
          return;
        }
        const channels = await guild.channels.fetch().catch(() => guild.channels.cache);
        const publicChannels = [...channels.values()]
          .filter(Boolean)
          .filter((channel) => DISCORD_TEXT_CHANNEL_TYPES.has(channel.type))
          .map((channel) => publicChannelInfo(channel, client))
          .sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || (a.name || "").localeCompare(b.name || ""));
        sendJson(res, 200, {
          ready: true,
          guild: publicGuildInfo(guild),
          total: publicChannels.length,
          channels: publicChannels,
        });
        return;
      }

      sendJson(res, 404, { error: "Not found" });
    } catch (error) {
      logger.error("MCP control request failed", error);
      if (!res.headersSent) {
        sendJson(res, 500, { error: "Internal server error" });
      }
    }
  });

  httpServer.listen(config.mcpControl.port, config.mcpControl.host, () => {
    logger.info(
      `MCP control server listening on http://${config.mcpControl.host}:${config.mcpControl.port}/sse`,
    );
  });

  return {
    address: () => httpServer.address(),
    close: () =>
      new Promise((resolve, reject) => {
        for (const transport of transports.values()) {
          transport.close().catch(() => undefined);
        }
        httpServer.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
