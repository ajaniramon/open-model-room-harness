import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  activeCircuitForItem,
  backoffMinutesForAttempt,
  createWakeCircuitState,
  normalizeBackoffSchedule,
} from "../backoff.js";
import { buildRelayWakePrompt } from "../wake-prompt.js";
import { normalizeRelayStatus, relayForFastLane, targetUrlForRelay, wakePromptForRelay } from "../relay-status.js";

const root = fileURLToPath(new URL("..", import.meta.url));

async function read(relativePath) {
  return readFile(join(root, relativePath), "utf8");
}

test("manifest references files that exist", async () => {
  const manifest = JSON.parse(await read("manifest.json"));
  const packageMetadata = JSON.parse(await read("package.json"));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, packageMetadata.version);
  assert.equal(manifest.background.service_worker, "background.js");

  const referencedFiles = [
    manifest.background.service_worker,
    manifest.action.default_popup,
    manifest.options_ui.page,
    ...manifest.content_scripts.flatMap((entry) => entry.js),
  ];

  await Promise.all(referencedFiles.map((path) => read(path)));
});

test("popup exposes automatic alarm diagnostics", async () => {
  const [background, popup] = await Promise.all([
    read("background.js"),
    read("popup.html"),
  ]);
  assert.match(background, /lastTrigger: source/);
  assert.match(background, /nextAlarmAt: alarm\?\.scheduledTime/);
  assert.match(popup, /id="trigger"/);
  assert.match(popup, /id="next"/);
  assert.match(popup, /id="queue-view"/);
  assert.match(background, /ownerOnly: settings\.ownerOnly/);
  assert.match(background, /settings\.relayTargetUrl, settings\.fastLaneTargetUrl, settings\.autonomousTargetUrl/);
});

test("configured task heartbeat supplements throttled Chrome alarms", async () => {
  const [background, content] = await Promise.all([
    read("background.js"),
    read("content.js"),
  ]);
  assert.match(content, /chat-relay:heartbeat/);
  assert.match(content, /HEARTBEAT_INTERVAL_MS = 15_000/);
  assert.match(background, /normalizedTaskUrl\(sender\?\.tab\?\.url/);
  assert.match(content, /data-is-streaming/);
  assert.match(content, /stop-response-button/);
  assert.match(background, /lastHeartbeatCheckAt/);
  assert.match(background, /lastFastLaneHeartbeatCheckAt/);
  assert.match(background, /source: "fast-lane-heartbeat"/);
  assert.match(background, /fastOnly: true/);
  assert.match(background, /source: "heartbeat"/);
  assert.match(background, /checkInFlight/);
});

test("fast-lane-only work bypasses the ordinary active-count gate", async () => {
  const background = await read("background.js");
  assert.match(background, /fastLaneTargetUrl: ""/);
  assert.ok(background.includes("const selectedActiveCount = fastOnly ? relay.fastLaneActiveCount : relay.activeCount"));
  assert.ok(background.includes("if (!relay.enabled || selectedActiveCount === 0)"));
});

test("wake cooldown does not delay a newly arrived relay item", async () => {
  const background = await read("background.js");
  assert.match(background, /if \(!force && circuit && cooldownRemaining > 0\)/);
  assert.match(background, /same unresolved item is cooling down/);
  assert.match(background, /fastLaneWakeCircuitState/);
});

test("every wake prompt isolates the current request without suppressing memory", () => {
  const prompt = buildRelayWakePrompt("Check now.");
  assert.match(prompt, /^Check now\./);
  assert.match(prompt, /triggerText, replyTo, imageAttachments, emojiPalette/);
  assert.match(prompt, /not a signature or memory/);
  assert.match(prompt, /peek_chat_relay_item first/);
  assert.match(prompt, /claim that exact item ID with claim_chat_relay_item/);
  assert.match(prompt, /already_claimed or not_pending/);
  assert.match(prompt, /peek once more/);
  assert.match(prompt, /never retry this race more than once/);
  assert.match(prompt, /persistent memory, and general knowledge as background/);
  assert.match(prompt, /fact does not need to be repeated in the relay item/);
  assert.match(prompt, /Do not answer unrelated earlier turns/);
  assert.match(prompt, /does not prohibit using persistent memory/);
  assert.match(prompt, /exact claimed relay item/);
  assert.match(prompt, /complete_chat_relay_without_reply/);
  assert.match(prompt, /explicit tool statuses/);
  assert.match(prompt, /Do not infer or report a platform or safety block/);
});

test("owner-only wake prompt claims exactly the server-selected owner DM", () => {
  const prompt = buildRelayWakePrompt("Check owner work.", {
    ownerOnly: true,
    relayItemId: "relay-owner-1",
  });
  assert.match(prompt, /^Check owner work\./);
  assert.match(prompt, /configured-owner DM relay item relay-owner-1/);
  assert.match(prompt, /Claim exactly that item ID/);
  assert.match(prompt, /Do not peek or claim a different item/);
  assert.doesNotMatch(prompt, /Call peek_chat_relay_item first/);
  assert.throws(
    () => buildRelayWakePrompt("Check owner work.", { ownerOnly: true }),
    /exact relay item ID/,
  );
});

test("owner-only option requests the filtered authenticated wake view", async () => {
  const [background, options, markup] = await Promise.all([
    read("background.js"),
    read("options.js"),
    read("options.html"),
  ]);
  assert.match(background, /statusUrl\.searchParams\.set\("ownerOnly", "true"\)/);
  assert.match(background, /relayItemId: selectedRelay\.oldestPendingId/);
  assert.match(options, /ownerOnly: form\.ownerOnly\.checked/);
  assert.match(markup, /name="ownerOnly"/);
  assert.match(markup, /Wake only for configured owner DMs/);
});

test("extension scripts pass Node syntax checks", () => {
  for (const script of ["backoff.js", "relay-status.js", "wake-prompt.js", "background.js", "content.js", "options.js", "popup.js"]) {
    execFileSync(process.execPath, ["--check", join(root, script)], { stdio: "pipe" });
  }
});

test("normalizes relay lane metadata while preserving old harness compatibility", () => {
  const status = normalizeRelayStatus({
    pendingCount: 2,
    directPendingCount: 1,
    spontaneousPendingCount: 1,
    autonomousPendingCount: 0,
    fastLanePendingCount: 1,
    fastLaneActiveCount: 1,
    fastLanePendingKey: "relay-2",
    oldestFastLanePendingId: "relay-2",
    leasedCount: 0,
    activeCount: 2,
    pendingKey: "relay-1,relay-2",
    oldestPendingId: "relay-1",
    oldestPendingKind: "spontaneous",
  });
  assert.equal(status.spontaneousPendingCount, 1);
  assert.equal(status.autonomousPendingCount, 0);
  assert.equal(status.fastLanePendingCount, 1);
  assert.equal(status.oldestFastLanePendingId, "relay-2");
  assert.equal(status.oldestPendingKind, "spontaneous");
  assert.equal(normalizeRelayStatus({ pendingCount: 1, pendingKey: "legacy-1" }).oldestPendingKind, "direct");
  assert.throws(
    () => normalizeRelayStatus({ pendingCount: 1, directPendingCount: 1, spontaneousPendingCount: 1 }),
    /invalid pending-kind counts/,
  );

  const autonomous = normalizeRelayStatus({
    pendingCount: 1,
    directPendingCount: 0,
    spontaneousPendingCount: 0,
    autonomousPendingCount: 1,
    oldestPendingId: "heartbeat-1",
    oldestPendingKind: "autonomous",
  });
  assert.equal(autonomous.oldestPendingKind, "autonomous");

  const fastLane = relayForFastLane(status);
  assert.equal(fastLane.pendingCount, 1);
  assert.equal(fastLane.oldestPendingId, "relay-2");
  assert.equal(fastLane.oldestPendingKind, "direct");
  assert.equal(relayForFastLane(normalizeRelayStatus({ pendingCount: 0 })), null);
});

test("uses distinct prompts and targets for relay and autonomous work", () => {
  const settings = {
    wakePrompt: "direct",
    spontaneousWakePrompt: "spontaneous",
    autonomousWakePrompt: "autonomous",
    relayTargetUrl: "https://chatgpt.com/c/relay",
    autonomousTargetUrl: "https://chatgpt.com/c/autonomous",
  };
  assert.equal(wakePromptForRelay(settings, { oldestPendingKind: "direct" }), "direct");
  assert.equal(wakePromptForRelay(settings, { oldestPendingKind: "spontaneous" }), "spontaneous");
  assert.equal(wakePromptForRelay(settings, { oldestPendingKind: "autonomous" }), "autonomous");
  assert.equal(targetUrlForRelay(settings, { oldestPendingKind: "direct" }), settings.relayTargetUrl);
  assert.equal(targetUrlForRelay(settings, { oldestPendingKind: "spontaneous" }), settings.relayTargetUrl);
  assert.equal(targetUrlForRelay(settings, { oldestPendingKind: "autonomous" }), settings.autonomousTargetUrl);
});

test("options expose separate relay and autonomous ChatGPT lanes", async () => {
  const [options, markup] = await Promise.all([read("options.js"), read("options.html")]);
  assert.match(options, /relayTargetUrl: form\.relayTargetUrl\.value/);
  assert.match(options, /autonomousTargetUrl: form\.autonomousTargetUrl\.value/);
  assert.match(options, /fastLaneEnabled: form\.fastLaneEnabled\.checked/);
  assert.match(options, /fastLanePollSeconds: Number\(form\.fastLanePollSeconds\.value\)/);
  assert.match(markup, /name="relayTargetUrl"/);
  assert.match(markup, /name="autonomousTargetUrl"/);
  assert.match(markup, /name="fastLaneEnabled"/);
  assert.match(markup, /name="fastLanePollSeconds"/);
  assert.doesNotMatch(markup, /name="targetUrl"/);
});

test("options expose an authenticated relay queue flush control", async () => {
  const [options, markup] = await Promise.all([read("options.js"), read("options.html")]);
  assert.match(markup, /id="flushQueue"/);
  assert.match(markup, /name="flushLeased"/);
  assert.match(options, /apiUrlFromStatusUrl\(settings\.statusUrl, "\/api\/chat-relay\/flush"\)/);
  assert.match(options, /authorization: `Bearer \$\{settings\.wakeToken\}`/);
  assert.match(options, /includeLeased/);
});

test("direct owner attestation is limited to trusted submissions on one exact task", async () => {
  const [background, content, options, markup] = await Promise.all([
    read("background.js"),
    read("content.js"),
    read("options.js"),
    read("options.html"),
  ]);
  assert.match(content, /if \(!event\.isTrusted \|\| !isOwnerLane\(\)/);
  assert.match(content, /normalizedTaskUrl\(location\.href\).*normalizedTaskUrl\(ownerLaneSettings\.ownerTargetUrl\)/s);
  assert.match(content, /chat-relay:attest-owner-message/);
  assert.doesNotMatch(content, /directChatgptToken/);
  assert.match(background, /normalizedTaskUrl\(sender\?\.tab\?\.url/);
  assert.match(background, /\/v1\/ingress\/direct-chatgpt\/reference/);
  assert.match(background, /messageSha256: await sha256\(messageText\)/);
  assert.match(options, /directOwnerEnabled: form\.directOwnerEnabled\.checked/);
  assert.match(markup, /name="ownerTargetUrl"/);
  assert.match(markup, /name="directChatgptToken"/);
});

test("backoff schedule is normalized and capped", () => {
  assert.deepEqual(normalizeBackoffSchedule("5, 2, 30, nope, 2000"), [5, 5, 30, 1440]);
  assert.deepEqual(normalizeBackoffSchedule(""), [5, 15, 30, 60]);
  assert.equal(backoffMinutesForAttempt([5, 15, 30, 60], 1), 5);
  assert.equal(backoffMinutesForAttempt([5, 15, 30, 60], 3), 30);
  assert.equal(backoffMinutesForAttempt([5, 15, 30, 60], 99), 60);
});

test("circuit advances only while the same oldest item remains", () => {
  const first = createWakeCircuitState({ itemId: "relay-1", now: 1_000, schedule: [5, 15, 30] });
  assert.deepEqual(first, {
    itemId: "relay-1",
    attempts: 1,
    lastWakeAt: 1_000,
    backoffUntil: 301_000,
  });

  const second = createWakeCircuitState({ previous: first, itemId: "relay-1", now: 400_000, schedule: [5, 15, 30] });
  assert.equal(second.attempts, 2);
  assert.equal(second.backoffUntil, 1_300_000);
  assert.equal(activeCircuitForItem(second, "relay-2"), null);

  const replacement = createWakeCircuitState({ previous: second, itemId: "relay-2", now: 500_000, schedule: [5, 15, 30] });
  assert.equal(replacement.attempts, 1);
  assert.equal(createWakeCircuitState({ previous: replacement, itemId: "", now: 600_000, schedule: [5] }), null);
});

test("prototype contains no companion or Discord scope names", async () => {
  const source = await Promise.all([
    read("background.js"),
    read("content.js"),
    read("options.js"),
    read("popup.js"),
    read("manifest.json"),
  ]);
  const combined = source.join("\n").toLowerCase();
  for (const forbidden of ["gremy", "haven", "thirdeye", "guildid", "channelid"]) {
    assert.equal(combined.includes(forbidden), false, `found hardcoded name: ${forbidden}`);
  }
});

test("remote harness access is optional", async () => {
  const manifest = JSON.parse(await read("manifest.json"));
  assert.deepEqual(manifest.optional_host_permissions, ["https://*/*"]);
  assert.equal(manifest.host_permissions.includes("<all_urls>"), false);
});
