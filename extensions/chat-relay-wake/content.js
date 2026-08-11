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
  "button[aria-label*='Stop']",
];

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

  sendButton.click();
  return { status: "submitted" };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "chat-relay:wake") return false;
  handleWake(message.payload || {}).then(sendResponse).catch((error) => {
    sendResponse({ status: "failed", reason: error instanceof Error ? error.message : String(error) });
  });
  return true;
});
