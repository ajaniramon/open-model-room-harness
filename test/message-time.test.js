import assert from "node:assert/strict";
import test from "node:test";
import {
  formatAbsoluteTimestamp,
  formatMessageTimestamp,
  formatRelativeAge,
  formatTimestampInstruction,
  resolveTimeZone,
} from "../src/message-time.js";

const NOON_UTC = Date.parse("2026-08-01T12:00:00Z");

test("formats absolute timestamps in the configured time zone", () => {
  assert.equal(formatAbsoluteTimestamp(NOON_UTC, "UTC"), "2026-08-01 12:00:00");
  assert.equal(formatAbsoluteTimestamp(NOON_UTC, "Europe/Madrid"), "2026-08-01 14:00:00");
  assert.equal(formatAbsoluteTimestamp(NOON_UTC, "America/New_York"), "2026-08-01 08:00:00");
});

test("uses a 00-23 hour clock instead of a 24:00 midnight", () => {
  const midnight = Date.parse("2026-08-02T00:00:00Z");
  assert.equal(formatAbsoluteTimestamp(midnight, "UTC"), "2026-08-02 00:00:00");
});

test("describes message age with coarse, readable units", () => {
  assert.equal(formatRelativeAge(0), "just now");
  assert.equal(formatRelativeAge(30_000), "just now");
  assert.equal(formatRelativeAge(12 * 60_000), "12m ago");
  assert.equal(formatRelativeAge(60 * 60_000), "1h ago");
  assert.equal(formatRelativeAge(95 * 60_000), "1h 35m ago");
  assert.equal(formatRelativeAge(30 * 60 * 60_000), "1d 6h ago");
  assert.equal(formatRelativeAge(9 * 24 * 60 * 60_000), "9d ago");
});

test("clamps clock skew so future messages never report a negative age", () => {
  assert.equal(formatRelativeAge(-45_000), "just now");
});

test("combines the absolute stamp, zone, and age in one header fragment", () => {
  const posted = Date.parse("2026-08-01T11:48:00Z");
  assert.equal(
    formatMessageTimestamp(posted, NOON_UTC, "Europe/Madrid"),
    "2026-08-01 13:48:00 Europe/Madrid (12m ago)",
  );
});

test("tells the model the current time and forbids echoing headers", () => {
  const instruction = formatTimestampInstruction(NOON_UTC, "UTC");
  assert.match(instruction, /current time is 2026-08-01 12:00:00 UTC/);
  assert.match(instruction, /never repeat a header or timestamp/);
});

test("falls back to the host time zone and rejects invalid names", () => {
  assert.equal(resolveTimeZone("Europe/Madrid"), "Europe/Madrid");
  assert.equal(resolveTimeZone("  "), Intl.DateTimeFormat().resolvedOptions().timeZone);
  assert.throws(() => resolveTimeZone("Mars/Olympus_Mons"), /Invalid IANA time zone/);
});
