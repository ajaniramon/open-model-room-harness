import { DEFAULT_BACKOFF_SCHEDULE, normalizeBackoffSchedule } from "./backoff.js";

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

const form = document.querySelector("#settings-form");
const message = document.querySelector("#message");

function showMessage(text, kind = "success") {
  message.textContent = text;
  message.dataset.kind = kind;
}

async function loadSettings() {
  const settings = await chrome.storage.local.get(DEFAULTS);
  for (const [key, value] of Object.entries(settings)) {
    const input = form.elements.namedItem(key);
    if (!input) continue;
    if (input instanceof HTMLInputElement && input.type === "checkbox") input.checked = Boolean(value);
    else input.value = Array.isArray(value) ? value.join(", ") : String(value);
  }
}

function readSettings() {
  return {
    enabled: form.enabled.checked,
    statusUrl: form.statusUrl.value.trim(),
    wakeToken: form.wakeToken.value.trim(),
    targetUrl: form.targetUrl.value.trim(),
    pollMinutes: Number(form.pollMinutes.value),
    cooldownSeconds: Number(form.cooldownSeconds.value),
    backoffScheduleMinutes: normalizeBackoffSchedule(form.backoffScheduleMinutes.value),
    wakePrompt: form.wakePrompt.value.trim(),
    autoSubmit: form.autoSubmit.checked,
    openIfMissing: form.openIfMissing.checked,
  };
}

async function requestHarnessPermission(statusUrl) {
  const url = new URL(statusUrl);
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("Remote harness status URLs must use HTTPS");
  }
  if (loopback) return true;
  return chrome.permissions.request({ origins: [`${url.origin}/*`] });
}

async function saveSettings() {
  const settings = readSettings();
  if (!settings.wakePrompt) throw new Error("Wake prompt cannot be empty");
  if (!settings.wakeToken) throw new Error("A dedicated wake status token is required");
  const targetUrl = new URL(settings.targetUrl);
  if (!["chatgpt.com", "chat.openai.com"].includes(targetUrl.hostname) || !targetUrl.pathname.includes("/c/")) {
    throw new Error("Use the URL of an existing ChatGPT conversation");
  }
  const permissionGranted = await requestHarnessPermission(settings.statusUrl);
  if (!permissionGranted) throw new Error("Permission to contact the harness URL was not granted");
  await chrome.storage.local.set(settings);
  return settings;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await saveSettings();
    showMessage("Settings saved.");
  } catch (error) {
    showMessage(error instanceof Error ? error.message : String(error), "error");
  }
});

document.querySelector("#test").addEventListener("click", async () => {
  try {
    await saveSettings();
    showMessage("Checking harness...");
    const status = await chrome.runtime.sendMessage({ type: "chat-relay:check-now", force: true });
    showMessage(status?.message || "Check completed.", status?.state === "error" ? "error" : "success");
  } catch (error) {
    showMessage(error instanceof Error ? error.message : String(error), "error");
  }
});

loadSettings().catch((error) => showMessage(String(error), "error"));
