import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMemoryBlock,
  formatMemoryBlock,
  isReadable,
  orderMemories,
  selectFocus,
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

test("the core orders by recency, then significance — never by who is speaking", () => {
  const newest = record({ text: "newest note", createdAt: new Date(NOW - DAY_MS).toISOString() });
  const middleHigh = record({
    text: "older but important",
    significance: 5,
    createdAt: new Date(NOW - 5 * DAY_MS).toISOString(),
  });
  const middleLow = record({
    text: "older and minor",
    significance: 1,
    createdAt: new Date(NOW - 5 * DAY_MS).toISOString(),
  });
  const oldest = record({ text: "oldest note", createdAt: new Date(NOW - 40 * DAY_MS).toISOString() });

  const ordered = orderMemories([middleLow, oldest, newest, middleHigh]);
  assert.deepEqual(
    ordered.map((item) => item.text),
    ["newest note", "older but important", "older and minor", "oldest note"],
    "recency first; significance only breaks a same-day tie",
  );
});

test("the core is identical regardless of who is speaking — the cache invariant", () => {
  const records = [
    record({ subject: { userId: "1", displayName: "Owner" } }),
    record({ subject: { userId: "2", displayName: "Luca" } }),
  ];
  const store = { isOptedOut: () => false, active: () => records };
  const base = { guildId: "g1", channelId: "c1", queryText: "" };
  const forOne = buildMemoryBlock(store, { ...base, speakerUserId: "1" }).core;
  const forTwo = buildMemoryBlock(store, { ...base, speakerUserId: "2" }).core;
  assert.equal(forOne, forTwo, "the cacheable core must not depend on the speaker");
});

test("a fresh low-significance note outranks a stale high-significance one", () => {
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
  const ordered = orderMemories([stale, fresh]);
  assert.equal(ordered[0].text, "G has already fixed his PC", "recency wins over significance");

  const block = formatMemoryBlock(ordered);
  assert.match(block, /newer one supersedes the older/i);
  assert.ok(block.indexOf("already fixed") < block.indexOf("waiting for a replacement fan"));
});

test("the focus tail surfaces query-relevant and speaker notes not already in the core", () => {
  const speakerNote = record({
    text: "prefers dark roast coffee",
    subject: { userId: "9", displayName: "Speaker" },
    createdAt: new Date(NOW - 30 * DAY_MS).toISOString(),
  });
  const relevant = record({
    text: "the deployment pipeline runs on Kubernetes",
    keys: ["kubernetes", "deployment"],
    subject: { userId: "8", displayName: "Other" },
    createdAt: new Date(NOW - 30 * DAY_MS).toISOString(),
  });
  const irrelevant = record({
    text: "likes hiking on weekends",
    subject: { userId: "7", displayName: "Nobody" },
    createdAt: new Date(NOW - 30 * DAY_MS).toISOString(),
  });

  const focus = selectFocus([speakerNote, relevant, irrelevant], {
    queryText: "how does the kubernetes deployment work",
    speakerUserId: "9",
  });
  const texts = focus.map((r) => r.text);
  assert.ok(texts.includes("prefers dark roast coffee"), "the speaker's own note is always included");
  assert.ok(texts.includes("the deployment pipeline runs on Kubernetes"), "a query-relevant note is included");
  assert.ok(!texts.includes("likes hiking on weekends"), "an irrelevant non-speaker note is excluded");
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

test("the per-subject cap stops one participant from consuming the whole block", () => {
  const mine = Array.from({ length: 8 }, (_, i) =>
    record({ text: `chatty ${i}`, subject: { userId: "1", displayName: "Chatty" } }),
  );
  const others = Array.from({ length: 3 }, (_, i) =>
    record({ text: `other ${i}`, subject: { userId: `${i + 2}`, displayName: `U${i}` } }),
  );
  const { selected } = selectWithinBudget([...mine, ...others], {
    maxItems: 200,
    maxChars: 40_000,
    perSubjectMaxItems: 3,
  });
  const fromChatty = selected.filter((r) => r.subject.userId === "1");
  assert.equal(fromChatty.length, 3, "at most 3 notes from one subject");
  assert.equal(selected.length, 6, "the other subjects still get their notes");
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

test("reports how many memories the core evicted so a full block is visible", () => {
  const records = Array.from({ length: 5 }, (_, index) => record({ text: `fact ${index}` }));
  const store = { isOptedOut: () => false, active: () => records };
  // focusMaxItems: 0 isolates the core budget from the focus tail for this check.
  const { records: included, dropped } = buildMemoryBlock(store, {
    guildId: "g1",
    channelId: "c1",
    speakerUserId: "99",
    maxItems: 2,
    focusMaxItems: 0,
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
});

test("a note about an opted-out subject is never recalled, even on another's turn", () => {
  // The stored note is about user "1"; user "3" is speaking. Opt-out must hide it.
  const store = {
    isOptedOut: (userId) => userId === "1",
    active: () => [record({ subject: { userId: "1", displayName: "Owner" } })],
  };
  const { block } = buildMemoryBlock(store, {
    guildId: "g1",
    channelId: "c1",
    speakerUserId: "3",
  });
  assert.doesNotMatch(block, /Windows service/);
  assert.match(block, /say you do not remember/i);

  // A note about a still-consenting subject is unaffected.
  const consenting = {
    isOptedOut: () => false,
    active: () => [record({ subject: { userId: "2", displayName: "Luca" } })],
  };
  assert.match(
    buildMemoryBlock(consenting, { guildId: "g1", channelId: "c1", speakerUserId: "3" }).block,
    /Windows service/,
  );
});
