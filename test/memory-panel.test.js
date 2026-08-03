import assert from "node:assert/strict";
import test from "node:test";
import { toPanelPayload, toPanelRecord } from "../scripts/memory-panel.js";

function record(overrides = {}) {
  return {
    id: "mem_abc123",
    text: "Deploys on Fridays",
    keys: ["deploy"],
    subject: { userId: "1", displayName: "Owner" },
    scope: { guildId: "g1", channelId: null },
    privacy: "guild",
    significance: 4,
    createdAt: "2026-08-01T12:00:00.000Z",
    source: { channelId: "c1", messageId: "m1", origin: "extraction" },
    supersededBy: null,
    ...overrides,
  };
}

test("the panel payload exposes memory fields and nothing else", () => {
  const shaped = toPanelRecord(record());
  assert.deepEqual(Object.keys(shaped).sort(), [
    "channelId",
    "createdAt",
    "guildId",
    "id",
    "keys",
    "origin",
    "privacy",
    "significance",
    "subject",
    "subjectId",
    "text",
  ]);
  assert.equal(shaped.subject, "Owner");
  assert.equal(shaped.origin, "extraction");
});

test("falls back to the user ID when a note has no display name", () => {
  const shaped = toPanelRecord(record({ subject: { userId: "42", displayName: "" } }));
  assert.equal(shaped.subject, "42");
});

test("treats a note with no source as dictated", () => {
  assert.equal(toPanelRecord(record({ source: undefined })).origin, "explicit");
});

test("ships the injection budget so the panel can show how full it is", () => {
  const payload = toPanelPayload([record(), record()], {
    maxChars: 40_000,
    maxItems: 200,
    generatedAt: "2026-08-01T12:00:00.000Z",
  });
  assert.deepEqual(payload.budget, { maxChars: 40_000, maxItems: 200, perRecordOverhead: 40 });
  assert.equal(payload.records.length, 2);
  assert.equal(payload.generatedAt, "2026-08-01T12:00:00.000Z");
});
