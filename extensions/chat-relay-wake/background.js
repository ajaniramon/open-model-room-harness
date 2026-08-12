import {
  activeCircuitForItem,
  createWakeCircuitState,
  DEFAULT_BACKOFF_SCHEDULE,
  normalizeBackoffSchedule,
} from "./backoff.js";

const ALARM_NAME = "chat-relay-wake-poll";
let checkInFlight = null;

const DEFAULTS = {
  enabled: false,
  statusUrl: "http://127.0.0.1:3000/api/chat-relay/wake-status",
  wakeToken: "",
  targetUrl: "",
  pollMinutes: 1,
  cooldownSeconds: 180,
  backoffScheduleMinutes: DEFAULT_BACKOFF_SCHEDULE,
  wakePrompt: "Check and process pending chat relay items.",
  autoSubmit: true,
  openIfMissing: false,
};

const runtimeStatus = {
  state: "idle",
  message: "Not checked yet",
  checkedAt: null,
  pendingCount: null,
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
  const stored = await chrome.storage.local.get(DEFAULTS);
  return {
    ...DEFAULTS,
    ...stored,
    pollMinutes: clampNumber(stored.pollMinutes, 0.5, 60, DEFAULTS.pollMinutes),
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

function updateRuntimeStatus(patch) {
  Object.assign(runtimeStatus, patch);
  chrome.storage.local.set({ wakeRuntimeStatus: runtimeStatus }).catch(() => {});
}

async function configureAlarm() {
  const settings = await getSettings();
  await chrome.alarms.clear(ALARM_NAME);
  if (!settings.enabled) {
    updateRuntimeStatus({ nextAlarmAt: null });
    return;
  }
  chrome.alarms.create(ALARM_NAME, {
    delayInMinutes: 0.5,
    periodInMinutes: settings.pollMinutes,
  });
  const alarm = await chrome.alarms.get(ALARM_NAME);
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

  const response = await fetch(settings.statusUrl, {
    method: "GET",
    headers,
    cache: "no-store",
    redirect: "error",
  });

  if (!response.ok) {
    throw new Error(`Harness returned HTTP ${response.status}`);
  }

  const payload = await response.json();
  const pendingCount = Number(payload.pendingCount);
  const activeCount = Number(payload.activeCount ?? payload.pendingCount);
  const leasedCount = Number(payload.leasedCount ?? Math.max(0, activeCount - pendingCount));
  if (!Number.isInteger(pendingCount) || pendingCount < 0) {
    throw new Error("Harness response does not contain a valid pendingCount");
  }
  if (
    !Number.isInteger(activeCount) ||
    !Number.isInteger(leasedCount) ||
    leasedCount < 0 ||
    pendingCount + leasedCount !== activeCount
  ) {
    throw new Error("Harness response does not contain valid active relay counts");
  }

  return {
    enabled: payload.enabled !== false,
    pendingCount,
    leasedCount,
    activeCount,
    pendingKey: String(payload.pendingKey || ""),
    oldestPendingId: payload.oldestPendingId ? String(payload.oldestPendingId) : String(payload.pendingKey || "").split(",")[0],
    activeKey: String(payload.activeKey || payload.pendingKey || ""),
    oldestActiveId: payload.oldestActiveId
      ? String(payload.oldestActiveId)
      : String(payload.oldestPendingId || payload.pendingKey || "").split(",")[0],
  };
}

async function findTargetTab(targetUrl) {
  const normalizedTarget = normalizedTaskUrl(targetUrl);
  if (!normalizedTarget) return null;

  const target = new URL(normalizedTarget);
  const tabs = await chrome.tabs.query({ url: `${target.origin}/*` });
  return tabs.find((tab) => normalizedTaskUrl(tab.url || "") === normalizedTarget) || null;
}

async function wakeTarget(settings, reason) {
  let tab = await findTargetTab(settings.targetUrl);

  if (!tab && settings.openIfMissing) {
    tab = await chrome.tabs.create({ url: settings.targetUrl, active: false });
    await new Promise((resolve) => setTimeout(resolve, 2500));
  }

  if (!tab?.id) {
    return { status: "deferred", reason: "Configured ChatGPT task is not open" };
  }

  try {
    return await chrome.tabs.sendMessage(tab.id, {
      type: "chat-relay:wake",
      payload: {
        prompt: settings.wakePrompt,
        autoSubmit: settings.autoSubmit,
        reason,
      },
    });
  } catch (error) {
    return {
      status: "deferred",
      reason: `ChatGPT content script unavailable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function checkRelay({ force = false, source = "manual" } = {}) {
  const settings = await getSettings();
  const checkedAt = Date.now();
  const alarm = await chrome.alarms.get(ALARM_NAME);
  updateRuntimeStatus({
    checkedAt,
    lastTrigger: source,
    lastAlarmAt: source === "alarm" ? checkedAt : runtimeStatus.lastAlarmAt,
    nextAlarmAt: alarm?.scheduledTime || null,
  });

  if (!settings.enabled) {
    updateRuntimeStatus({ state: "disabled", message: "Wake relay is disabled", checkedAt });
    return runtimeStatus;
  }
  if (!settings.statusUrl || !settings.targetUrl) {
    updateRuntimeStatus({ state: "configuration", message: "Status URL and ChatGPT task URL are required", checkedAt });
    return runtimeStatus;
  }

  try {
    const relay = await fetchRelayStatus(settings);
    updateRuntimeStatus({ checkedAt, pendingCount: relay.pendingCount, activeCount: relay.activeCount });

    if (!relay.enabled || relay.activeCount === 0) {
      await chrome.storage.local.remove("wakeCircuitState");
      updateRuntimeStatus({
        state: "idle",
        message: relay.enabled ? "No pending relay work" : "Harness relay is disabled",
        unresolvedAttempts: 0,
        backoffUntil: null,
      });
      return runtimeStatus;
    }

    if (relay.pendingCount === 0) {
      updateRuntimeStatus({
        state: "processing",
        message: `${relay.leasedCount} relay item(s) currently being processed`,
      });
      return runtimeStatus;
    }

    const stored = await chrome.storage.local.get({ lastWakeAt: 0, wakeCircuitState: null });
    const savedCircuit = stored.wakeCircuitState;
    const circuit = activeCircuitForItem(savedCircuit, relay.oldestActiveId);
    if (!circuit && savedCircuit) {
      await chrome.storage.local.remove("wakeCircuitState");
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

    const cooldownRemaining = settings.cooldownSeconds * 1000 - (Date.now() - Number(stored.lastWakeAt || 0));
    if (!force && cooldownRemaining > 0) {
      updateRuntimeStatus({
        state: "cooldown",
        message: `Pending work found; cooldown has ${Math.ceil(cooldownRemaining / 1000)}s remaining`,
      });
      return runtimeStatus;
    }

    const result = await wakeTarget(settings, {
      pendingCount: relay.pendingCount,
      activeKey: relay.activeKey,
    });

    if (result?.status === "submitted" || result?.status === "inserted") {
      const lastWakeAt = Date.now();
      const wakeCircuitState = createWakeCircuitState({
        previous: circuit,
        itemId: relay.oldestActiveId,
        now: lastWakeAt,
        schedule: settings.backoffScheduleMinutes,
      });
      const backoffUntil = wakeCircuitState?.backoffUntil || null;
      await chrome.storage.local.set({ lastWakeAt, wakeCircuitState });
      updateRuntimeStatus({
        state: result.status,
        message: result.status === "submitted" ? "ChatGPT task was woken" : "Wake prompt inserted for review",
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
  if (normalizedTaskUrl(sender?.tab?.url || "") !== normalizedTaskUrl(settings.targetUrl)) {
    return runtimeStatus;
  }

  const now = Date.now();
  const stored = await chrome.storage.local.get({ lastHeartbeatCheckAt: 0 });
  const intervalMs = settings.pollMinutes * 60_000;
  if (now - Number(stored.lastHeartbeatCheckAt || 0) < intervalMs) return runtimeStatus;

  // Reserve this interval before the asynchronous fetch so duplicate task tabs
  // cannot start the same poll concurrently.
  await chrome.storage.local.set({ lastHeartbeatCheckAt: now });
  return runRelayCheck({ source: "heartbeat" });
}

chrome.runtime.onInstalled.addListener(() => {
  configureAlarm().catch(reportAlarmConfigurationError);
});

chrome.runtime.onStartup.addListener(() => {
  configureAlarm().catch(reportAlarmConfigurationError);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    runRelayCheck({ source: "alarm" }).catch((error) =>
      updateRuntimeStatus({
        state: "error",
        message: error instanceof Error ? error.message : String(error),
      }),
    );
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  if (Object.keys(changes).some((key) => key in DEFAULTS)) {
    configureAlarm().catch(reportAlarmConfigurationError);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "chat-relay:check-now") {
    runRelayCheck({ force: Boolean(message.force), source: message.force ? "force" : "manual" }).then(sendResponse);
    return true;
  }
  if (message?.type === "chat-relay:heartbeat") {
    handleTargetHeartbeat(sender).then(sendResponse).catch((error) =>
      sendResponse({ state: "error", message: error instanceof Error ? error.message : String(error) }),
    );
    return true;
  }
  if (message?.type === "chat-relay:get-status") {
    chrome.storage.local.get({ wakeRuntimeStatus: runtimeStatus }).then(({ wakeRuntimeStatus }) => sendResponse(wakeRuntimeStatus));
    return true;
  }
  return false;
});

configureAlarm().catch(reportAlarmConfigurationError);
