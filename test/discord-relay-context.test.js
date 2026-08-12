import assert from "node:assert/strict";
import test from "node:test";
import { resolveRelayReplyTo } from "../src/discord-bot.js";

const BOT = { id: "bot-1", username: "assistant" };

function triggeringMessage(fetch) {
  return {
    id: "trigger-1",
    channelId: "channel-1",
    guildId: "guild-1",
    reference: {
      messageId: "reply-1",
      channelId: "channel-1",
      guildId: "guild-1",
    },
    channel: { messages: { fetch } },
  };
}

test("resolves the Discord message a relay trigger replied to", async () => {
  const replyTo = await resolveRelayReplyTo(triggeringMessage(async (id) => {
    assert.equal(id, "reply-1");
    return {
      id,
      content: "the actual Discord message",
      author: { id: "bot-1", username: "assistant", globalName: "Assistant", bot: true },
      member: { displayName: "Room Assistant" },
      attachments: new Map(),
    };
  }), BOT);

  assert.deepEqual(replyTo, {
    messageId: "reply-1",
    channelId: "channel-1",
    guildId: "guild-1",
    resolved: true,
    author: {
      id: "bot-1",
      username: "assistant",
      displayName: "Room Assistant",
      bot: true,
    },
    content: "the actual Discord message",
  });
});

test("keeps reply identity when the referenced message is unavailable", async () => {
  const replyTo = await resolveRelayReplyTo(triggeringMessage(async () => {
    throw new Error("deleted or inaccessible");
  }), BOT);

  assert.deepEqual(replyTo, {
    messageId: "reply-1",
    channelId: "channel-1",
    guildId: "guild-1",
    resolved: false,
    author: null,
    content: null,
  });
});

test("returns no reply context for a normal Discord message", async () => {
  assert.equal(await resolveRelayReplyTo({ reference: null }, BOT), null);
});
