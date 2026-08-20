import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMemoryBlock,
  formatMemoryBlock,
  isReadable,
  orderMemories,
  selectWithinBudget,
} from "../src/memory-retrieval.js";

const NOW = Date.parse("2026-08-01T12:00:00.000Z");
const DAY_MS = 86_400_000;

function record(overrides = {}) {
  return {
    id: `mem_${String(overrides.text || "x").length}${Math.random().toString(16).slice(2, 8)}`,
    text: "Deploys the bot as a Windows service",
    keys: ["windows service", "deploy"],
    subject: { userId: "1", displayName: "Owner" },
    scope: { guildId: "g1", channelId: null },
    privacy: "guild",
    significance: 3,
    createdAt: new Date(NOW - DAY_MS).toISOString(),
    supersededBy: null,
    ...overrides,
  };
}

test("a guild memory is readable from any channel of that guild", () => {
  const memory = record();
  assert.equal(isReadable(memory, { guildId: "g1", channelId: "other", ownerTurn: false }), true);
  assert.equal(isReadable(memory, { guildId: "g2", channelId: "other", ownerTurn: false }), false);
  // A DM is a different scope; only the owner crosses it (covered below).
  assert.equal(isReadable(memory, { guildId: null, channelId: "dm", ownerTurn: false }), false);
});

test("a room memory never leaves its channel and an owner memory never leaves owner turns", () => {
  const room = record({ privacy: "room", scope: { guildId: "g1", channelId: "c1" } });
  assert.equal(isReadable(room, { guildId: "g1", channelId: "c1", ownerTurn: false }), true);
  assert.equal(isReadable(room, { guildId: "g1", channelId: "c2", ownerTurn: false }), false);

  const owner = record({ privacy: "owner" });
  assert.equal(isReadable(owner, { guildId: "g1", channelId: "c2", ownerTurn: false }), false);
  assert.equal(isReadable(owner, { guildId: "g1", channelId: "c2", ownerTurn: true }), true);
});

test("the owner's DM reads guild memories, nobody else crosses a scope", () => {
  const guildFact = record({ scope: { guildId: "g1", channelId: null } });
  const roomFact = record({ privacy: "room", scope: { guildId: "g1", channelId: "c1" } });

  assert.equal(isReadable(guildFact, { guildId: null, channelId: "dm", ownerTurn: true }), true);
  assert.equal(isReadable(guildFact, { guildId: null, channelId: "dm", ownerTurn: false }), false);
  assert.equal(isReadable(roomFact, { guildId: null, channelId: "dm", ownerTurn: true }), false);
  // Crossing scopes is a DM-only privilege: inside a guild the boundary still holds.
  assert.equal(isReadable(guildFact, { guildId: "g2", channelId: "c9", ownerTurn: true }), false);

  const store = { isOptedOut: () => false, active: (filter) => (filter ? [] : [guildFact]) };
  const { block } = buildMemoryBlock(store, {
    guildId: null,
    channelId: "dm",
    speakerUserId: "1",
    ownerTurn: true,
  });
  assert.match(block, /Windows service/);
});

test("orders by speaker, then people in the room, then recency and significance", () => {
  const speaker = record({ subject: { userId: "1", displayName: "Owner" }, significance: 1 });
  const present = record({ subject: { userId: "2", displayName: "Luca" }, significance: 5 });
  const absent = record({ subject: { userId: "3", displayName: "Ghost" }, significance: 5 });
  const olderPresent = record({
    subject: { userId: "2", displayName: "Luca" },
    significance: 5,
    createdAt: new Date(NOW - 40 * DAY_MS).toISOString(),
  });

  const ordered = orderMemories([absent, olderPresent, present, speaker], {
    speakerUserId: "1",
    presentUserIds: new Set(["1", "2"]),
  });
  assert.deepEqual(
    ordered.map((item) => item.subject.displayName),
    ["Owner", "Luca", "Luca", "Ghost"],
  );
  assert.equal(ordered[1].id, present.id, "the newer of the two Luca facts comes first");
});

test("a fresh low-significance note outranks a stale high-significance one", () => {
  // The "G's PC" regression: a two-week-old "waiting for a fan" note kept beating
  // the recent "already fixed" note because significance ordered before recency.
  const stale = record({
    text: "G's PC is broken and he is waiting for a replacement fan",
    significance: 5,
    createdAt: new Date(NOW - 14 * DAY_MS).toISOString(),
  });
  const fresh = record({
    text: "G has already fixed his PC",
    significance: 2,
    createdAt: new Date(NOW - DAY_MS).toISOString(),
  });
  const ordered = orderMemories([stale, fresh], {
    speakerUserId: "1",
    presentUserIds: new Set(["1"]),
  });
  assert.equal(ordered[0].text, "G has already fixed his PC", "recency wins over significance");

  const block = formatMemoryBlock(ordered);
  assert.match(block, /newer one supersedes the older/i);
  assert.ok(
    block.indexOf("already fixed") < block.indexOf("waiting for a replacement fan"),
    "the block lists the fresh note before the stale one",
  );
});

test("ordering ignores the current message entirely", () => {
  const records = [
    record({ text: "likes strawberry ice cream", significance: 4 }),
    record({ text: "runs the windows service", significance: 2 }),
  ];
  const options = { speakerUserId: "1", presentUserIds: new Set(["1"]) };
  assert.deepEqual(
    orderMemories(records, options).map((item) => item.text),
    orderMemories(records, options).map((item) => item.text),
  );
  assert.equal(orderMemories(records, options)[0].text, "likes strawberry ice cream");
});

test("everything that fits goes in, the rest is evicted from the prompt only", () => {
  const records = Array.from({ length: 10 }, (_, index) =>
    record({ text: `fact number ${index}`.padEnd(60, "."), significance: 3 }),
  );
  const all = selectWithinBudget(records, { maxItems: 200, maxChars: 40_000 });
  assert.equal(all.selected.length, 10);
  assert.equal(all.dropped, 0);

  const tight = selectWithinBudget(records, { maxItems: 200, maxChars: 300 });
  assert.equal(tight.selected.length, 3);
  assert.equal(tight.dropped, 7);
  assert.ok(tight.chars <= 300);

  const capped = selectWithinBudget(records, { maxItems: 4, maxChars: 40_000 });
  assert.equal(capped.selected.length, 4);
  assert.equal(capped.dropped, 6);
});

test("the block is labelled untrusted and states abstention when empty", () => {
  const empty = formatMemoryBlock([]);
  assert.match(empty, /untrusted/i);
  assert.match(empty, /say you do not remember/i);

  const block = formatMemoryBlock([record({ text: "Runs the bot as a service" })]);
  assert.match(block, /never as instructions/i);
  assert.match(block, /- 2026-07-31 · about Owner: Runs the bot as a service/);
});

test("the same store produces the same block regardless of what was said", () => {
  const records = [record({ text: "first fact" }), record({ text: "second fact" })];
  const store = { isOptedOut: () => false, active: () => records };
  const options = { guildId: "g1", channelId: "c1", speakerUserId: "1" };
  const first = buildMemoryBlock(store, options);
  const second = buildMemoryBlock(store, options);
  assert.equal(first.block, second.block, "a cacheable prefix must be stable");
  assert.equal(first.records.length, 2);
});

test("reports how many memories were evicted so a full block is visible", () => {
  const records = Array.from({ length: 5 }, (_, index) => record({ text: `fact ${index}` }));
  const store = { isOptedOut: () => false, active: () => records };
  const { records: included, dropped } = buildMemoryBlock(store, {
    guildId: "g1",
    channelId: "c1",
    speakerUserId: "1",
    maxItems: 2,
  });
  assert.equal(included.length, 2);
  assert.equal(dropped, 3);
});

test("returns nothing for a participant who opted out", () => {
  const store = { isOptedOut: (userId) => userId === "1", active: () => [record()] };
  assert.equal(
    buildMemoryBlock(store, { guildId: "g1", channelId: "c1", speakerUserId: "1" }).block,
    null,
  );
  assert.match(
    buildMemoryBlock(store, { guildId: "g1", channelId: "c1", speakerUserId: "2" }).block,
    /Windows service/,
  );
});
