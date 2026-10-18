const COMPOSER_SELECTORS = [
  "#prompt-textarea[contenteditable='true']",
  "textarea#prompt-textarea",
  "div[contenteditable='true'][data-virtualkeyboard='true']",
  "main form div[contenteditable='true']",
];

const SEND_BUTTON_SELECTORS = [
  "button[data-testid='send-button']",
  "button[aria-label='Send message']",
  "button[aria-label='Send prompt']",
];

const STOP_BUTTON_SELECTORS = [
  "button[data-testid='stop-button']",
  "button[data-testid='stop-response-button']",
  "button[aria-label*='Stop']",
  "button[aria-label*='stop']",
  "[data-is-streaming='true']",
  ".result-streaming",
];

const HEARTBEAT_INTERVAL_MS = 15_000;
const OWNER_EVENT_MARKER = "Trusted owner capability event reference";
let ownerLaneSettings = { directOwnerEnabled: false, ownerTargetUrl: "" };
let ownerAttestationInFlight = false;

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

async function refreshOwnerLaneSettings() {
  ownerLaneSettings = await chrome.storage.local.get({ directOwnerEnabled: false, ownerTargetUrl: "" });
}

function isOwnerLane() {
  return ownerLaneSettings.directOwnerEnabled === true &&
    normalizedTaskUrl(location.href) === normalizedTaskUrl(ownerLaneSettings.ownerTargetUrl);
}

function sendHeartbeat() {
  chrome.runtime.sendMessage({ type: "chat-relay:heartbeat" }).catch(() => {});
}

sendHeartbeat();
setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
refreshOwnerLaneSettings().catch(() => {});
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && (changes.directOwnerEnabled || changes.ownerTargetUrl)) {
    refreshOwnerLaneSettings().catch(() => {});
  }
});

function firstMatch(selectors) {
  for (const selector of selectors) {
    const element = document.querySelector(selector);
    if (element) return element;
  }
  return null;
}

function composerText(composer) {
  if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) {
    return composer.value.trim();
  }
  return (composer.textContent || "").trim();
}

function isBusy() {
  return Boolean(firstMatch(STOP_BUTTON_SELECTORS));
}

function insertPrompt(composer, prompt) {
  composer.focus();

  if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(composer), "value")?.set;
    if (setter) setter.call(composer, prompt);
    else composer.value = prompt;
    composer.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: prompt }));
    return composerText(composer) === prompt;
  }

  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(composer);
  selection?.removeAllRanges();
  selection?.addRange(range);

  let inserted = false;
  try {
    inserted = document.execCommand("insertText", false, prompt);
  } catch {
    inserted = false;
  }

  if (!inserted || composerText(composer) !== prompt) {
    composer.textContent = prompt;
  }
  composer.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: prompt }));
  return composerText(composer) === prompt;
}

async function waitForEnabledSendButton(timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const button = firstMatch(SEND_BUTTON_SELECTORS);
    if (button instanceof HTMLButtonElement && !button.disabled && button.getAttribute("aria-disabled") !== "true") {
      return button;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

async function waitForSubmission(composer, previousUserMessageCount, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const userMessageCount = document.querySelectorAll("[data-message-author-role='user']").length;
    if (!composer.isConnected || !composerText(composer) || isBusy() || userMessageCount > previousUserMessageCount) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

async function handleWake({ prompt, autoSubmit }) {
  if (isBusy()) {
    return { status: "deferred", reason: "ChatGPT is currently responding" };
  }

  const composer = firstMatch(COMPOSER_SELECTORS);
  if (!(composer instanceof HTMLElement)) {
    return { status: "deferred", reason: "ChatGPT composer was not found" };
  }

  if (composerText(composer)) {
    return { status: "deferred", reason: "ChatGPT composer contains an unsent draft" };
  }

  if (!insertPrompt(composer, String(prompt || "").trim())) {
    return { status: "failed", reason: "Wake prompt could not be inserted" };
  }

  if (!autoSubmit) {
    return { status: "inserted" };
  }

  const sendButton = await waitForEnabledSendButton();
  if (!sendButton) {
    return { status: "failed", reason: "ChatGPT send button did not become available" };
  }

  const previousUserMessageCount = document.querySelectorAll("[data-message-author-role='user']").length;
  sendButton.click();
  if (!(await waitForSubmission(composer, previousUserMessageCount))) {
    return { status: "failed", reason: "ChatGPT did not confirm prompt submission" };
  }
  return { status: "submitted" };
}

async function attestAndSubmitOwnerMessage(event) {
  if (!event.isTrusted || !isOwnerLane() || ownerAttestationInFlight || isBusy()) return;
  const composer = firstMatch(COMPOSER_SELECTORS);
  if (!(composer instanceof HTMLElement)) return;
  const messageText = composerText(composer);
  if (!messageText || messageText.includes(OWNER_EVENT_MARKER)) return;

  event.preventDefault();
  event.stopImmediatePropagation();
  ownerAttestationInFlight = true;
  try {
    const attestation = await chrome.runtime.sendMessage({
      type: "chat-relay:attest-owner-message",
      messageText,
    });
    if (attestation?.status !== "attested" || !attestation.eventRef) {
      throw new Error(attestation?.reason || "Owner attestation was not issued");
    }

    const taggedMessage = `${messageText}\n\n[${OWNER_EVENT_MARKER}: ${attestation.eventRef}. Use this as capabilityEventRef for privileged tools in this turn.]`;
    if (!insertPrompt(composer, taggedMessage)) {
      throw new Error("Owner event reference could not be attached to the message");
    }
    const sendButton = await waitForEnabledSendButton();
    if (!sendButton) throw new Error("ChatGPT send button did not become available");
    sendButton.click();
  } catch (error) {
    window.alert(`Owner attestation failed; the message was not sent.\n\n${error instanceof Error ? error.message : String(error)}`);
  } finally {
    ownerAttestationInFlight = false;
  }
}

document.addEventListener("click", (event) => {
  if (!(event.target instanceof Element)) return;
  if (event.target.closest(SEND_BUTTON_SELECTORS.join(","))) attestAndSubmitOwnerMessage(event);
}, true);

document.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey || event.isComposing) return;
  if (!(event.target instanceof Element) || !event.target.closest(COMPOSER_SELECTORS.join(","))) return;
  attestAndSubmitOwnerMessage(event);
}, true);

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "chat-relay:wake") return false;
  handleWake(message.payload || {}).then(sendResponse).catch((error) => {
    sendResponse({ status: "failed", reason: error instanceof Error ? error.message : String(error) });
  });
  return true;
});
