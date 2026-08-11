const ALARM_NAME = "chat-relay-wake-poll";

const DEFAULTS = {
  enabled: false,
  statusUrl: "http://127.0.0.1:3000/api/chat-relay/wake-status",
  bearerToken: "",
  targetUrl: "",
  pollMinutes: 1,
  cooldownSeconds: 180,
  wakePrompt: "Check and process pending chat relay items.",
  autoSubmit: true,
  openIfMissing: false,
};

const runtimeStatus = {
  state: "idle",
  message: "Not checked yet",
  checkedAt: null,
  pendingCount: null,
  lastWakeAt: null,
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
  if (!settings.enabled) return;
  chrome.alarms.create(ALARM_NAME, {
    delayInMinutes: 0.5,
    periodInMinutes: settings.pollMinutes,
  });
}

async function fetchRelayStatus(settings) {
  const headers = {
    accept: "application/json",
    "ngrok-skip-browser-warning": "chat-relay-wake",
  };
  if (settings.bearerToken) {
    headers.authorization = `Bearer ${settings.bearerToken}`;
  }

  const response = await fetch(settings.statusUrl, {
    method: "GET",
    headers,
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Harness returned HTTP ${response.status}`);
  }

  const payload = await response.json();
  const pendingCount = Number(payload.pendingCount);
  if (!Number.isInteger(pendingCount) || pendingCount < 0) {
    throw new Error("Harness response does not contain a valid pendingCount");
  }

  return {
    enabled: payload.enabled !== false,
    pendingCount,
    pendingKey: String(payload.pendingKey || ""),
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

async function checkRelay({ ignoreCooldown = false } = {}) {
  const settings = await getSettings();
  const checkedAt = Date.now();

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
    updateRuntimeStatus({ checkedAt, pendingCount: relay.pendingCount });

    if (!relay.enabled || relay.pendingCount === 0) {
      updateRuntimeStatus({ state: "idle", message: relay.enabled ? "No pending relay work" : "Harness relay is disabled" });
      return runtimeStatus;
    }

    const stored = await chrome.storage.local.get({ lastWakeAt: 0 });
    const cooldownRemaining = settings.cooldownSeconds * 1000 - (Date.now() - Number(stored.lastWakeAt || 0));
    if (!ignoreCooldown && cooldownRemaining > 0) {
      updateRuntimeStatus({
        state: "cooldown",
        message: `Pending work found; cooldown has ${Math.ceil(cooldownRemaining / 1000)}s remaining`,
      });
      return runtimeStatus;
    }

    const result = await wakeTarget(settings, {
      pendingCount: relay.pendingCount,
      pendingKey: relay.pendingKey,
    });

    if (result?.status === "submitted" || result?.status === "inserted") {
      const lastWakeAt = Date.now();
      await chrome.storage.local.set({ lastWakeAt });
      updateRuntimeStatus({
        state: result.status,
        message: result.status === "submitted" ? "ChatGPT task was woken" : "Wake prompt inserted for review",
        lastWakeAt,
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

chrome.runtime.onInstalled.addListener(() => {
  configureAlarm().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  configureAlarm().catch(() => {});
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) checkRelay().catch(() => {});
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  if (Object.keys(changes).some((key) => key in DEFAULTS)) {
    configureAlarm().catch(() => {});
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "chat-relay:check-now") {
    checkRelay({ ignoreCooldown: Boolean(message.ignoreCooldown) }).then(sendResponse);
    return true;
  }
  if (message?.type === "chat-relay:get-status") {
    chrome.storage.local.get({ wakeRuntimeStatus: runtimeStatus }).then(({ wakeRuntimeStatus }) => sendResponse(wakeRuntimeStatus));
    return true;
  }
  return false;
});

configureAlarm().catch(() => {});
