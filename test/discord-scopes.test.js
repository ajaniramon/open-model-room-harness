import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeDiscordScopes,
  resolveDiscordScope,
  scopeAllowsChannel,
  validateScopeName,
} from "../src/discord-scopes.js";

test("normalizes named Discord scopes with safe defaults", () => {
  const scopes = normalizeDiscordScopes({
    publicChat: {
      label: "Public Chat",
      guildIds: ["guild-1"],
      channelIds: ["channel-1"],
      allowSend: true,
    },
  });

  assert.deepEqual(resolveDiscordScope(scopes, "publicChat"), {
    name: "publicChat",
    label: "Public Chat",
    guildIds: ["guild-1"],
    channelIds: ["channel-1"],
    defaultChannelId: "channel-1",
    allowSend: true,
    allowRelayReply: true,
    attentionMode: "mentions_only",
    names: [],
    keywords: [],
    includeRepliesToSelf: true,
  });
});

test("rejects unsafe scope names", () => {
  assert.equal(validateScopeName("public_chat-1"), "public_chat-1");
  assert.throws(() => validateScopeName("../oops"), /scope/);
});

test("rejects send-enabled scopes without a guild or channel boundary", () => {
  assert.throws(
    () => normalizeDiscordScopes({ everywhere: { allowSend: true } }),
    /must restrict at least one guild or channel/,
  );
});

test("checks guild, channel, and thread parent scope membership", () => {
  const scope = resolveDiscordScope({
    lounge: {
      guildIds: ["guild-1"],
      channelIds: ["channel-1"],
    },
  }, "lounge");

  assert.equal(scopeAllowsChannel(scope, { guildId: "guild-1", channelId: "channel-1" }), true);
  assert.equal(scopeAllowsChannel(scope, { guildId: "guild-1", channelId: "thread-1", parentId: "channel-1" }), true);
  assert.equal(scopeAllowsChannel(scope, { guildId: "guild-2", channelId: "channel-1" }), false);
  assert.equal(scopeAllowsChannel(scope, { guildId: null, channelId: "channel-1" }), false);
  assert.equal(scopeAllowsChannel(scope, { guildId: "guild-1", channelId: "channel-2" }), false);
});
