import {
  activeCircuitForItem,
  createWakeCircuitState,
  DEFAULT_BACKOFF_SCHEDULE,
  normalizeBackoffSchedule,
} from "./backoff.js";
import { buildRelayWakePrompt } from "./wake-prompt.js";
import { normalizeRelayStatus, relayForFastLane, targetUrlForRelay, wakePromptForRelay } from "./relay-status.js";

const extensionApi = globalThis.browser ?? globalThis.chrome;

const ALARM_NAME = "chat-relay-wake-poll";
let checkInFlight = null;
let orchestrationDeliveryInFlight = null;

const DEFAULTS = {
  enabled: false,
  ownerOnly: false,
  statusUrl: "http://127.0.0.1:3000/api/chat-relay/wake-status",
  wakeToken: "",
  relayTargetUrl: "",
  fastLaneTargetUrl: "",
  autonomousTargetUrl: "",
  directOwnerEnabled: false,
  ownerTargetUrl: "",
  brokerUrl: "http://127.0.0.1:3400",
  directChatgptToken: "",
  directOwnerAudiences: ["filesystem", "execution", "discord"],
  // Retained only to migrate installations from the original single-lane setting.
  targetUrl: "",
  pollMinutes: 1,
  fastLaneEnabled: true,
  fastLanePollSeconds: 15,
  cooldownSeconds: 180,
  backoffScheduleMinutes: DEFAULT_BACKOFF_SCHEDULE,
  wakePrompt: "Check and process pending chat relay items.",
  spontaneousWakePrompt: "Check and process pending spontaneous chat relay items. Claim the authoritative item and decide whether to participate or dismiss it.",
  autonomousWakePrompt: "Check and process the pending autonomous opportunity. Claim the authoritative item, inspect its context, and independently decide whether to act or do nothing.",
  autoSubmit: true,
  openIfMissing: false,
  orchestrationDeliveryEnabled: false,
  orchestrationDeliveryUrl: "",
  orchestrationDeliveryToken: "",
};

const runtimeStatus = {
  state: "idle",
  message: "Not checked yet",
  ownerOnly: false,
  checkedAt: null,
  pendingCount: null,
  directPendingCount: null,
  spontaneousPendingCount: null,
  autonomousPendingCount: null,
  fastLanePendingCount: null,
  oldestPendingKind: null,
  activeCount: null,
  lastWakeAt: null,
  lastTrigger: null,
  lastAlarmAt: null,
  nextAlarmAt: null,
  unresolvedAttempts: 0,
  backoffUntil: null,
};

function clampNumber(value, minimum, maximum, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, number));
}

async function getSettings() {
  const stored = await extensionApi.storage.local.get(DEFAULTS);
  return {
    ...DEFAULTS,
    ...stored,
    relayTargetUrl: stored.relayTargetUrl || stored.targetUrl || "",
    fastLaneTargetUrl: stored.fastLaneTargetUrl || "",
    autonomousTargetUrl: stored.autonomousTargetUrl || "",
    pollMinutes: clampNumber(stored.pollMinutes, 0.5, 60, DEFAULTS.pollMinutes),
    fastLaneEnabled: stored.fastLaneEnabled !== false,
    fastLanePollSeconds: clampNumber(stored.fastLanePollSeconds, 5, 300, DEFAULTS.fastLanePollSeconds),
    cooldownSeconds: clampNumber(stored.cooldownSeconds, 30, 3600, DEFAULTS.cooldownSeconds),
    backoffScheduleMinutes: normalizeBackoffSchedule(stored.backoffScheduleMinutes),
  };
}

function normalizedTaskUrl(value) {
  try {
    const url = new URL(value);
    url.hash = "";
    url.search = "";
    url.pathname = url.pathname.replace(/\/$/, "");
    return url.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}

function conversationKey(value) {
  try {
    const url = new URL(value);
    const match = url.pathname.match(/\/c\/([^/]+)\/?$/);
    if (!match) return "";
    const host = url.hostname === "chat.openai.com" ? "chatgpt.com" : url.hostname;
    return `${host}:c:${match[1]}`;
  } catch {
    return "";
  }
}

function updateRuntimeStatus(patch) {
  Object.assign(runtimeStatus, patch);
  extensionApi.storage.local.set({ wakeRuntimeStatus: runtimeStatus }).catch(() => {});
}

async function configureAlarm() {
  const settings = await getSettings();
  await extensionApi.alarms.clear(ALARM_NAME);
  if (!settings.enabled) {
    updateRuntimeStatus({ nextAlarmAt: null });
    return;
  }
  extensionApi.alarms.create(ALARM_NAME, {
    delayInMinutes: 0.5,
    periodInMinutes: settings.pollMinutes,
  });
  const alarm = await extensionApi.alarms.get(ALARM_NAME);
  if (!alarm) throw new Error("Chrome did not create the automatic relay alarm");
  updateRuntimeStatus({ nextAlarmAt: alarm.scheduledTime || null });
}

async function reportAlarmConfigurationError(error) {
  updateRuntimeStatus({
    state: "error",
    message: `Could not schedule automatic checks: ${error instanceof Error ? error.message : String(error)}`,
    nextAlarmAt: null,
  });
}

async function fetchRelayStatus(settings) {
  const statusUrl = new URL(settings.statusUrl);
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(statusUrl.hostname);
  if (statusUrl.protocol !== "https:" && !(statusUrl.protocol === "http:" && loopback)) {
    throw new Error("Remote harness status URLs must use HTTPS");
  }
  const headers = {
    accept: "application/json",
    "ngrok-skip-browser-warning": "chat-relay-wake",
  };
  if (settings.wakeToken) {
    headers.authorization = `Bearer ${settings.wakeToken}`;
  }
  if (settings.ownerOnly) statusUrl.searchParams.set("ownerOnly", "true");

  const response = await fetch(statusUrl.toString(), {
    method: "GET",
    headers,
    cache: "no-store",
    redirect: "error",
  });

  if (!response.ok) {
    throw new Error(`Harness returned HTTP ${response.status}`);
  }

  return normalizeRelayStatus(await response.json());
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function validatedServiceUrl(value, label) {
  const url = new URL(value);
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error(`Remote ${label} URLs must use HTTPS`);
  }
  return url;
}

async function attestOwnerMessage(settings, sender, messageText) {
  if (!settings.directOwnerEnabled) return { status: "not-owner-lane" };
  if (normalizedTaskUrl(sender?.tab?.url || "") !== normalizedTaskUrl(settings.ownerTargetUrl)) {
    return { status: "not-owner-lane" };
  }
  if (!settings.brokerUrl || !settings.directChatgptToken) {
    return { status: "failed", reason: "Direct ChatGPT attestation is not configured" };
  }

  const brokerUrl = validatedServiceUrl(settings.brokerUrl, "broker");
  brokerUrl.pathname = `${brokerUrl.pathname.replace(/\/$/, "")}/v1/ingress/direct-chatgpt/reference`;
  const response = await fetch(brokerUrl.toString(), {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${settings.directChatgptToken}`,
      "content-type": "application/json",
      "ngrok-skip-browser-warning": "chat-relay-wake",
    },
    body: JSON.stringify({
      audiences: settings.directOwnerAudiences,
      sourceEventId: `direct-chatgpt:${crypto.randomUUID()}`,
      messageSha256: await sha256(messageText),
    }),
    cache: "no-store",
    redirect: "error",
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload?.eventRef) {
    throw new Error(payload?.error?.message || `Broker returned HTTP ${response.status}`);
  }
  return { status: "attested", eventRef: String(payload.eventRef), expiresAt: payload.expiresAt || null };
}

async function findTargetTabs(targetUrl) {
  const targetKey = conversationKey(targetUrl);
  if (!targetKey) return [];

  const tabs = await extensionApi.tabs.query({
    url: ["https://chatgpt.com/*", "https://chat.openai.com/*"],
  });
  return tabs
    .filter((tab) => conversationKey(tab.url || "") === targetKey)
    .sort((left, right) => {
      if (Boolean(left.discarded) !== Boolean(right.discarded)) return left.discarded ? 1 : -1;
      return Number(right.lastAccessed || 0) - Number(left.lastAccessed || 0);
    });
}

async function wakeTarget(settings, targetUrl, reason, prompt = settings.wakePrompt, promptOptions = {}) {
  let tabs = await findTargetTabs(targetUrl);

  if (tabs.length === 0 && settings.openIfMissing) {
    const tab = await extensionApi.tabs.create({ url: targetUrl, active: false });
    await new Promise((resolve) => setTimeout(resolve, 2500));
    tabs = tab?.id ? [tab] : [];
  }

  if (tabs.length === 0) {
    return { status: "deferred", reason: "Configured ChatGPT task is not open" };
  }

  let unavailableReason = "ChatGPT content script unavailable";
  for (const tab of tabs) {
    if (!tab.id) continue;
    try {
      return await extensionApi.tabs.sendMessage(tab.id, {
        type: "chat-relay:wake",
        payload: {
          prompt: buildRelayWakePrompt(prompt, promptOptions),
          autoSubmit: settings.autoSubmit,
          reason,
        },
      });
    } catch (error) {
      unavailableReason = `ChatGPT content script unavailable: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  return { status: "deferred", reason: unavailableReason };
}

async function checkRelay({ force = false, source = "manual", fastOnly = false } = {}) {
  const settings = await getSettings();
  const checkedAt = Date.now();
  const alarm = await extensionApi.alarms.get(ALARM_NAME);
  updateRuntimeStatus({
    checkedAt,
    ownerOnly: settings.ownerOnly,
    lastTrigger: source,
    lastAlarmAt: source === "alarm" ? checkedAt : runtimeStatus.lastAlarmAt,
    nextAlarmAt: alarm?.scheduledTime || null,
  });

  if (!settings.enabled) {
    updateRuntimeStatus({ state: "disabled", message: "Wake relay is disabled", checkedAt });
    return runtimeStatus;
  }
  if (!settings.statusUrl || !settings.relayTargetUrl) {
    updateRuntimeStatus({ state: "configuration", message: "Status URL and Discord relay ChatGPT URL are required", checkedAt });
    return runtimeStatus;
  }

  try {
    const relay = await fetchRelayStatus(settings);
    updateRuntimeStatus({
      checkedAt,
      pendingCount: relay.pendingCount,
      directPendingCount: relay.directPendingCount,
      spontaneousPendingCount: relay.spontaneousPendingCount,
      autonomousPendingCount: relay.autonomousPendingCount,
      fastLanePendingCount: relay.fastLanePendingCount,
      oldestPendingKind: relay.oldestPendingKind,
      activeCount: relay.activeCount,
    });

    const selectedActiveCount = fastOnly ? relay.fastLaneActiveCount : relay.activeCount;
    if (!relay.enabled || selectedActiveCount === 0) {
      await extensionApi.storage.local.remove("wakeCircuitState");
      updateRuntimeStatus({
        state: "idle",
        message: relay.enabled ? "No pending relay work" : "Harness relay is disabled",
        unresolvedAttempts: 0,
        backoffUntil: null,
      });
      return runtimeStatus;
    }

    const selectedRelay = fastOnly ? relayForFastLane(relay) : relay;
    if (fastOnly && !selectedRelay) {
      updateRuntimeStatus({
        state: "idle",
        message: "No fast-lane relay work",
      });
      return runtimeStatus;
    }

    if (selectedRelay.pendingCount === 0) {
      updateRuntimeStatus({
        state: "processing",
        message: `${selectedRelay.leasedCount} relay item(s) currently being processed`,
      });
      return runtimeStatus;
    }

    const lastWakeKey = fastOnly ? "fastLaneLastWakeAt" : "lastWakeAt";
    const circuitKey = fastOnly ? "fastLaneWakeCircuitState" : "wakeCircuitState";
    const stored = await extensionApi.storage.local.get({ [lastWakeKey]: 0, [circuitKey]: null });
    const savedCircuit = stored[circuitKey];
    const circuit = activeCircuitForItem(savedCircuit, selectedRelay.oldestActiveId);
    if (!circuit && savedCircuit) {
      await extensionApi.storage.local.remove(circuitKey);
      updateRuntimeStatus({ unresolvedAttempts: 0, backoffUntil: null });
    }

    const backoffRemaining = Number(circuit?.backoffUntil || 0) - Date.now();
    if (!force && backoffRemaining > 0) {
      updateRuntimeStatus({
        state: "backoff",
        message: `Pending work is unchanged; retry paused for ${Math.ceil(backoffRemaining / 60000)}m`,
        unresolvedAttempts: Number(circuit.attempts || 0),
        backoffUntil: Number(circuit.backoffUntil),
      });
      return runtimeStatus;
    }

    const cooldownRemaining = settings.cooldownSeconds * 1000 - (Date.now() - Number(stored[lastWakeKey] || 0));
    if (!force && circuit && cooldownRemaining > 0) {
      updateRuntimeStatus({
        state: "cooldown",
        message: `The same unresolved item is cooling down for ${Math.ceil(cooldownRemaining / 1000)}s`,
      });
      return runtimeStatus;
    }

    const targetUrl = fastOnly
      ? settings.fastLaneTargetUrl || settings.relayTargetUrl
      : targetUrlForRelay(settings, selectedRelay);
    if (!targetUrl) {
      updateRuntimeStatus({
        state: "configuration",
        message: selectedRelay.oldestPendingKind === "autonomous"
          ? "Autonomous work is pending, but no autonomous ChatGPT URL is configured"
          : "No ChatGPT URL is configured for this relay lane",
      });
      return runtimeStatus;
    }

    const result = await wakeTarget(settings, targetUrl, {
      pendingCount: relay.pendingCount,
      activeKey: selectedRelay.activeKey,
      pendingKind: selectedRelay.oldestPendingKind,
      directPendingCount: relay.directPendingCount,
      spontaneousPendingCount: relay.spontaneousPendingCount,
      autonomousPendingCount: relay.autonomousPendingCount,
    }, wakePromptForRelay(settings, selectedRelay), {
      ownerOnly: settings.ownerOnly,
      fastLane: fastOnly,
      relayItemId: selectedRelay.oldestPendingId,
    });

    if (result?.status === "submitted" || result?.status === "inserted") {
      const lastWakeAt = Date.now();
      const wakeCircuitState = createWakeCircuitState({
        previous: circuit,
        itemId: selectedRelay.oldestActiveId,
        now: lastWakeAt,
        schedule: settings.backoffScheduleMinutes,
      });
      const backoffUntil = wakeCircuitState?.backoffUntil || null;
      await extensionApi.storage.local.set({ [lastWakeKey]: lastWakeAt, [circuitKey]: wakeCircuitState });
      updateRuntimeStatus({
        state: result.status,
        message: result.status === "submitted"
          ? selectedRelay.oldestPendingKind === "autonomous" ? "Autonomous ChatGPT task was woken" : settings.ownerOnly ? "ChatGPT task was woken for owner DM relay work" : fastOnly ? "Fast-lane ChatGPT task was woken" : selectedRelay.oldestPendingKind === "spontaneous" ? "ChatGPT task was woken for spontaneous relay work" : "ChatGPT task was woken"
          : selectedRelay.oldestPendingKind === "autonomous" ? "Autonomous wake prompt inserted for review" : settings.ownerOnly ? "Owner DM wake prompt inserted for review" : fastOnly ? "Fast-lane wake prompt inserted for review" : selectedRelay.oldestPendingKind === "spontaneous" ? "Spontaneous wake prompt inserted for review" : "Wake prompt inserted for review",
        lastWakeAt,
        unresolvedAttempts: wakeCircuitState?.attempts || 0,
        backoffUntil,
      });
    } else {
      updateRuntimeStatus({ state: result?.status || "deferred", message: result?.reason || "Wake was deferred" });
    }
  } catch (error) {
    updateRuntimeStatus({
      state: "error",
      message: error instanceof Error ? error.message : String(error),
      checkedAt,
    });
  }

  return runtimeStatus;
}

function runRelayCheck(options) {
  if (checkInFlight) return checkInFlight;
  checkInFlight = checkRelay(options).finally(() => {
    checkInFlight = null;
  });
  return checkInFlight;
}

async function handleTargetHeartbeat(sender) {
  const settings = await getSettings();
  if (!settings.enabled) return runtimeStatus;
  const senderUrl = normalizedTaskUrl(sender?.tab?.url || "");
  const configuredTargets = [settings.relayTargetUrl, settings.fastLaneTargetUrl, settings.autonomousTargetUrl]
    .map(normalizedTaskUrl)
    .filter(Boolean);
  if (!configuredTargets.includes(senderUrl)) {
    return runtimeStatus;
  }

  const now = Date.now();
  const stored = await extensionApi.storage.local.get({ lastHeartbeatCheckAt: 0, lastFastLaneHeartbeatCheckAt: 0 });
  if (settings.fastLaneEnabled) {
    const fastLaneIntervalMs = settings.fastLanePollSeconds * 1000;
    if (now - Number(stored.lastFastLaneHeartbeatCheckAt || 0) >= fastLaneIntervalMs) {
      await extensionApi.storage.local.set({ lastFastLaneHeartbeatCheckAt: now });
      return runRelayCheck({ source: "fast-lane-heartbeat", fastOnly: true });
    }
  }

  const intervalMs = settings.pollMinutes * 60_000;
  if (now - Number(stored.lastHeartbeatCheckAt || 0) < intervalMs) return runtimeStatus;

  // Reserve this interval before the asynchronous fetch so duplicate task tabs
  // cannot start the same poll concurrently.
  await extensionApi.storage.local.set({ lastHeartbeatCheckAt: now });
  return runRelayCheck({ source: "heartbeat" });
}

async function postOrchestrationDelivery(settings, path, body) {
  const baseUrl = validatedServiceUrl(settings.orchestrationDeliveryUrl, "orchestration delivery");
  const url = new URL(path, baseUrl);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${settings.orchestrationDeliveryToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    cache: "no-store",
    redirect: "error",
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.ok !== true) {
    throw new Error(payload?.error || `Orchestration delivery returned HTTP ${response.status}`);
  }
  return payload;
}

async function deliverOrchestrationWork(sender) {
  const settings = await getSettings();
  if (!settings.orchestrationDeliveryEnabled) return { status: "disabled" };
  if (!settings.orchestrationDeliveryUrl || !settings.orchestrationDeliveryToken) {
    return { status: "configuration", reason: "Orchestration delivery is not configured" };
  }
  const tabId = sender?.tab?.id;
  if (typeof tabId !== "number") return { status: "deferred", reason: "Browser tab identity is unavailable" };

  const page = await extensionApi.tabs.sendMessage(tabId, { type: "chat-relay:orchestration-state" });
  const turnEvents = Array.isArray(page?.turnEvents) ? page.turnEvents : [];
  if (turnEvents.length > 0) {
    const accepted = await postOrchestrationDelivery(settings, "/v1/browser-turns", {
      observedUrl: page?.observedUrl,
      browserTabId: String(tabId),
      events: turnEvents,
    });
    if (accepted.status === "accepted") {
      await extensionApi.tabs.sendMessage(tabId, {
        type: "chat-relay:orchestration-turn-events-ack",
        eventIds: accepted.results.map((result) => result.eventId),
      });
    }
  }

  const pull = await postOrchestrationDelivery(settings, "/v1/browser-delivery/pull", {
    observedUrl: page?.observedUrl,
    browserTabId: String(tabId),
    ready: page?.ready === true,
    busy: page?.busy === true,
    hasDraft: page?.hasDraft === true,
  });
  if (pull.status !== "reserved") return pull;

  let outcome;
  try {
    const submission = await extensionApi.tabs.sendMessage(tabId, {
      type: "chat-relay:orchestration-submit",
      payload: { prompt: pull.input.body },
    });
    outcome = submission?.status === "submitted"
      ? { status: "submitted", evidence: { browserSubmissionConfirmed: true } }
      : submission?.status === "deferred" || submission?.status === "failed"
        ? { status: "failed", reason: submission.reason || "browser did not submit" }
        : { status: "unknown", reason: "browser returned an unrecognized submission result" };
  } catch (error) {
    outcome = { status: "unknown", reason: error instanceof Error ? error.message : String(error) };
  }

  return postOrchestrationDelivery(
    settings,
    `/v1/browser-delivery/attempts/${encodeURIComponent(pull.attemptId)}/outcome`,
    { observedUrl: page.observedUrl, browserTabId: String(tabId), ...outcome },
  );
}

function runOrchestrationDelivery(sender) {
  if (orchestrationDeliveryInFlight) return orchestrationDeliveryInFlight;
  orchestrationDeliveryInFlight = deliverOrchestrationWork(sender).finally(() => {
    orchestrationDeliveryInFlight = null;
  });
  return orchestrationDeliveryInFlight;
}

extensionApi.runtime.onInstalled.addListener(() => {
  configureAlarm().catch(reportAlarmConfigurationError);
});

extensionApi.runtime.onStartup.addListener(() => {
  configureAlarm().catch(reportAlarmConfigurationError);
});

extensionApi.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    runRelayCheck({ source: "alarm" }).catch((error) =>
      updateRuntimeStatus({
        state: "error",
        message: error instanceof Error ? error.message : String(error),
      }),
    );
  }
});

extensionApi.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  if (Object.keys(changes).some((key) => key in DEFAULTS)) {
    configureAlarm().catch(reportAlarmConfigurationError);
  }
});

async function sendAttestedOwnerShortcut(commandTab) {
  const tab = commandTab?.id
    ? commandTab
    : (await extensionApi.tabs.query({ active: true, lastFocusedWindow: true }))[0];
  if (!tab?.id) throw new Error("The active browser tab could not be identified");
  return extensionApi.tabs.sendMessage(tab.id, { type: "chat-relay:attested-owner-submit" });
}

extensionApi.commands.onCommand.addListener((command, tab) => {
  if (command !== "send-attested-message") return;
  sendAttestedOwnerShortcut(tab).catch((error) => console.warn("Attested owner shortcut failed", error));
});

extensionApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "chat-relay:check-now") {
    runRelayCheck({ force: Boolean(message.force), source: message.force ? "force" : "manual" }).then(sendResponse);
    return true;
  }
  if (message?.type === "chat-relay:heartbeat") {
    Promise.all([handleTargetHeartbeat(sender), runOrchestrationDelivery(sender)])
      .then(([relay, orchestration]) => sendResponse({ ...relay, orchestration }))
      .catch((error) => sendResponse({ state: "error", message: error instanceof Error ? error.message : String(error) }));
    return true;
  }
  if (message?.type === "chat-relay:get-status") {
    extensionApi.storage.local.get({ wakeRuntimeStatus: runtimeStatus, ownerLaneDiagnostic: null })
      .then(({ wakeRuntimeStatus, ownerLaneDiagnostic }) => sendResponse({ ...wakeRuntimeStatus, ownerLaneDiagnostic }));
    return true;
  }
  if (message?.type === "chat-relay:owner-lane-diagnostic") {
    extensionApi.storage.local.set({
      ownerLaneDiagnostic: {
        state: String(message.state || "unknown"),
        details: message.details && typeof message.details === "object" ? message.details : {},
        observedAt: Date.now(),
      },
    }).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message?.type === "chat-relay:attest-owner-message") {
    getSettings()
      .then((settings) => attestOwnerMessage(settings, sender, String(message.messageText || "")))
      .then(sendResponse)
      .catch((error) => sendResponse({ status: "failed", reason: error instanceof Error ? error.message : String(error) }));
    return true;
  }
  return false;
});

configureAlarm().catch(reportAlarmConfigurationError);
