import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  executeMemoryCommand,
  isMemoryAuthorized,
  parseMemoryCommand,
} from "../src/memory-commands.js";
import { MemoryStore } from "../src/memory-store.js";

const NOW = Date.parse("2026-08-01T12:00:00.000Z");
const CONTEXT = {
  userId: "1",
  displayName: "Owner",
  guildId: "g1",
  channelId: "c1",
  messageId: "m1",
};

async function withStore(run) {
  const root = await mkdtemp(join(tmpdir(), "memory-commands-"));
  try {
    await run(
      await new MemoryStore({ path: join(root, "memory.jsonl"), now: () => NOW }).load(),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("parses memory commands in English and Spanish", () => {
  assert.deepEqual(parseMemoryCommand("@bot remember that I deploy on Fridays"), {
    action: "remember",
    text: "I deploy on Fridays",
    privacy: "guild",
  });
  assert.deepEqual(parseMemoryCommand("recuerda: despliego los viernes"), {
    action: "remember",
    text: "despliego los viernes",
    privacy: "guild",
  });
  assert.deepEqual(parseMemoryCommand("@bot remember privately: my key is in 1Password"), {
    action: "remember",
    text: "my key is in 1Password",
    privacy: "owner",
  });
  assert.deepEqual(parseMemoryCommand("recuerda solo aquí: esto es del canal"), {
    action: "remember",
    text: "esto es del canal",
    privacy: "room",
  });
  assert.deepEqual(parseMemoryCommand("@bot what do you remember about me"), { action: "list" });
  assert.deepEqual(parseMemoryCommand("qué recuerdas de mí"), { action: "list" });
  assert.deepEqual(parseMemoryCommand("@bot what do you remember"), { action: "list_all" });
  assert.deepEqual(parseMemoryCommand("qué recuerdas"), { action: "list_all" });
  assert.deepEqual(parseMemoryCommand("@bot what do you remember about everyone"), {
    action: "list_all",
  });
  assert.deepEqual(parseMemoryCommand("forget everything about me"), { action: "forget_all" });
  assert.deepEqual(parseMemoryCommand("@bot forget the deploy note"), {
    action: "forget",
    query: "the deploy note",
  });
  assert.deepEqual(parseMemoryCommand("export my memory"), { action: "export" });
  assert.deepEqual(parseMemoryCommand("@bot digest now"), { action: "digest" });
  assert.deepEqual(parseMemoryCommand("digiere"), { action: "digest" });
  assert.deepEqual(parseMemoryCommand("memory off"), { action: "consent", enabled: false });
  assert.deepEqual(parseMemoryCommand("activa la memoria"), { action: "consent", enabled: true });
});

test("does not mistake questions or ordinary chat for memory commands", () => {
  assert.equal(parseMemoryCommand("@bot recuerdas cuando petó el servicio?"), null);
  assert.equal(parseMemoryCommand("do you remember when we broke prod?"), null);
  assert.equal(parseMemoryCommand("@bot what is a memory leak"), null);
  assert.equal(parseMemoryCommand("remember"), null);
  assert.equal(parseMemoryCommand("@bot remember when we broke prod?"), null);
  assert.equal(parseMemoryCommand("recuerda cuando petó el deploy?"), null);
});

test("authorizes memory controls only for configured identities", () => {
  const config = {
    memoryAllowedUserIds: new Set(["123"]),
    memoryAllowedUsernames: new Set(["owner_handle"]),
  };
  assert.equal(isMemoryAuthorized({ id: "123", username: "renamed" }, config), true);
  assert.equal(isMemoryAuthorized({ id: "999", username: "Owner_Handle" }, config), true);
  assert.equal(isMemoryAuthorized({ id: "999", username: "stranger" }, config), false);
});

test("stores a guild-wide memory and reports its reach", async () => {
  await withStore(async (store) => {
    const result = await executeMemoryCommand(
      { action: "remember", text: "Deploys on Fridays", privacy: "guild" },
      store,
      CONTEXT,
    );
    assert.match(result.response, /\[remembered\] Deploys on Fridays/);
    assert.match(result.response, /every channel in this server/);
    const stored = store.active()[0];
    assert.equal(stored.scope.guildId, "g1");
    assert.equal(stored.scope.channelId, null);
    assert.equal(stored.source.origin, "explicit");
  });
});

test("keeps a private memory owner-scoped and a DM memory out of guild scope", async () => {
  await withStore(async (store) => {
    await executeMemoryCommand(
      { action: "remember", text: "Sensitive detail", privacy: "owner" },
      store,
      CONTEXT,
    );
    assert.equal(store.active()[0].privacy, "owner");

    await executeMemoryCommand(
      { action: "remember", text: "Said in a DM", privacy: "guild" },
      store,
      { ...CONTEXT, guildId: null },
    );
    const dm = store.active().find((record) => record.text === "Said in a DM");
    assert.equal(dm.privacy, "owner");
    assert.equal(dm.scope.guildId, null);
  });
});

test("refuses to store for a participant who opted out", async () => {
  await withStore(async (store) => {
    await executeMemoryCommand({ action: "consent", enabled: false }, store, CONTEXT);
    const result = await executeMemoryCommand(
      { action: "remember", text: "should not be stored", privacy: "guild" },
      store,
      CONTEXT,
    );
    assert.match(result.response, /Memory is disabled for you/);
    assert.equal(store.active().length, 0);
  });
});

test("lists, forgets by query and disambiguates multiple matches", async () => {
  await withStore(async (store) => {
    await executeMemoryCommand(
      { action: "remember", text: "Deploys the service on Fridays", privacy: "guild" },
      store,
      CONTEXT,
    );
    await executeMemoryCommand(
      { action: "remember", text: "Restarts the service after config edits", privacy: "guild" },
      store,
      CONTEXT,
    );

    const listed = await executeMemoryCommand({ action: "list" }, store, CONTEXT);
    assert.match(listed.response, /Stored memory about you \(2\)/);

    const ambiguous = await executeMemoryCommand(
      { action: "forget", query: "service" },
      store,
      CONTEXT,
    );
    assert.match(ambiguous.response, /matches 2 notes/);
    assert.equal(store.active().length, 2);

    const removed = await executeMemoryCommand(
      { action: "forget", query: "fridays" },
      store,
      CONTEXT,
    );
    assert.match(removed.response, /\[forgotten\]/);
    assert.equal(store.active().length, 1);

    const missing = await executeMemoryCommand(
      { action: "forget", query: "kubernetes" },
      store,
      CONTEXT,
    );
    assert.match(missing.response, /no stored note matching/i);
  });
});

test("lists everything readable here, grouped by person, not just about you", async () => {
  await withStore(async (store) => {
    await store.remember({
      text: "Runs the Friday deploys",
      subject: { userId: "2", displayName: "Luca" },
      scope: { guildId: "g1", channelId: "c1" },
      privacy: "guild",
    });
    await store.remember({
      text: "Keeps notes in the ops repo",
      subject: { userId: "3", displayName: "Sky" },
      scope: { guildId: "g1", channelId: "c9" },
      privacy: "room",
    });
    await store.remember({
      text: "Owns the release checklist",
      subject: { userId: "1", displayName: "Owner" },
      scope: { guildId: "g1", channelId: "c1" },
      privacy: "guild",
    });

    const here = await executeMemoryCommand({ action: "list_all" }, store, CONTEXT);
    assert.match(here.response, /2 note\(s\), 2 person\/people/);
    assert.match(here.response, /\*\*Luca\*\*/);
    assert.match(here.response, /Friday deploys/);
    // The room-scoped note belongs to another channel, so it stays out.
    assert.doesNotMatch(here.response, /ops repo/);

    const there = await executeMemoryCommand({ action: "list_all" }, store, {
      ...CONTEXT,
      channelId: "c9",
    });
    assert.match(there.response, /ops repo/);
  });
});

test("list_all says so plainly when nothing is readable here", async () => {
  await withStore(async (store) => {
    const result = await executeMemoryCommand({ action: "list_all" }, store, CONTEXT);
    assert.match(result.response, /nothing stored that I can recall here/i);
  });
});

test("exports as a JSON attachment and forgets everything on request", async () => {
  await withStore(async (store) => {
    await executeMemoryCommand(
      { action: "remember", text: "Exportable note", privacy: "guild" },
      store,
      CONTEXT,
    );
    const exported = await executeMemoryCommand({ action: "export" }, store, CONTEXT);
    assert.equal(exported.attachment.name, "memory-1.json");
    assert.equal(JSON.parse(exported.attachment.content).count, 1);

    const purged = await executeMemoryCommand({ action: "forget_all" }, store, CONTEXT);
    assert.match(purged.response, /Deleted 1 stored note/);
    assert.equal(store.active().length, 0);
  });
});
