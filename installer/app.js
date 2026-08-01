const form = document.querySelector("#setup-form");
const providers = document.querySelector("#providers");
const log = document.querySelector("#log");
const errorBox = document.querySelector("#form-error");
const model = document.querySelector("#model");
const meter = document.querySelector("#meter-fill");
const integrityLabel = document.querySelector("#integrity-label");
const progress = document.querySelector("#progress");
const percent = document.querySelector("#percent");
const stageLabel = document.querySelector("#progress-label");
let definitions = {};
let modelLoadTimer;
let modelRequestSequence = 0;

function addLog(stage, message, state = "RUN") {
  const line = document.createElement("p");
  if (state === "ERR") line.className = "err";
  const tag = document.createElement("b");
  tag.textContent = `[${stage}] `;
  line.append(tag, document.createTextNode(message));
  log.append(line);
  log.scrollTop = log.scrollHeight;
}

function chooseProvider(provider) {
  const definition = definitions[provider];
  if (!definition) return;
  const local = provider === "local";
  model.value = definition.defaultModel;
  document.querySelector("#model-options").replaceChildren();
  setModelStatus(local ? "START SERVER TO LOAD CATALOG" : "PASTE KEY TO LOAD CATALOG");
  document.querySelector("#provider-name").textContent = definition.label.toUpperCase();
  document.querySelector("#nanogpt-sidecar").classList.toggle("hidden", provider === "nanogpt");
  document.querySelector("#local-endpoint-row").classList.toggle("hidden", !local);
  const keyInput = document.querySelector("#primary-api-key");
  keyInput.required = !definition.apiKeyOptional;
  keyInput.placeholder = local ? "OPTIONAL — ONLY IF YOUR SERVER REQUIRES IT" : "";
  document.querySelector("#api-key-label").firstChild.textContent = local
    ? "API.KEY, OPTiONAL AUTH FOR "
    : "API.KEY, FiND THE GOOD KEY FOR ";
  if (local || keyInput.value.trim()) scheduleModelLoad(0);
}

function setModelStatus(message, state = "") {
  const status = document.querySelector("#model-status");
  status.textContent = message;
  status.className = state;
}

async function loadModels() {
  const provider = new FormData(form).get("provider");
  const apiKey = document.querySelector("#primary-api-key").value.trim();
  const local = provider === "local";
  const baseUrl = document.querySelector("#local-base-url").value.trim();
  if (!apiKey && !local) {
    setModelStatus("PASTE KEY TO LOAD CATALOG");
    return;
  }
  const sequence = ++modelRequestSequence;
  const refresh = document.querySelector("#refresh-models");
  refresh.disabled = true;
  setModelStatus("SCANNiNG...");
  try {
    const models = await window.installer.listModels(provider, apiKey, baseUrl);
    if (sequence !== modelRequestSequence) return;
    const options = document.querySelector("#model-options");
    options.replaceChildren(
      ...models.map((id) => {
        const option = document.createElement("option");
        option.value = id;
        return option;
      }),
    );
    if (!models.includes(model.value)) model.value = models[0];
    setModelStatus(`${models.length} MODELS READY`, "ready");
    addLog("MODELS", `${definitions[provider].label}: loaded ${models.length} compatible routes.`, "OK");
  } catch (error) {
    if (sequence !== modelRequestSequence) return;
    setModelStatus("MANUAL MODEL ENABLED", "fault");
    addLog("MODELS", `${error.message} You can still type a model ID manually.`, "ERR");
  } finally {
    if (sequence === modelRequestSequence) refresh.disabled = false;
  }
}

function scheduleModelLoad(delay = 550) {
  clearTimeout(modelLoadTimer);
  modelLoadTimer = setTimeout(() => void loadModels(), delay);
}

function updateMeter() {
  const data = new FormData(form);
  let score = 10;
  for (const key of ["discordToken", "primaryApiKey", "baseUrl", "ownerId", "ownerUsername", "tavilyApiKey", "elevenLabsApiKey"]) {
    if (String(data.get(key) || "").trim()) score += key.includes("owner") ? 10 : 15;
  }
  const value = Math.min(score, 100);
  meter.style.width = `${value}%`;
  integrityLabel.textContent = value >= 70 ? "CONFIG LOOKS COMPLETE" : "AWAITING INPUT";
}

function handleProgress(event) {
  addLog(event.stage, event.message, event.state);
  const stages = { WRITE: 18, NPM: 42, CODEX: 64, TEST: 78, DONE: 100, FAULT: 100 };
  const amount = stages[event.stage] || 10;
  progress.style.width = `${amount}%`;
  percent.textContent = `${String(amount).padStart(2, "0")}%`;
  stageLabel.textContent = event.stage;
  if (event.stage === "DONE" || event.stage === "FAULT") {
    document.querySelector("#generate").disabled = false;
    if (event.stage === "DONE") document.querySelector("#generate span").textContent = "RiG ARMED ✓";
  }
}

async function boot() {
  if (!window.installer) throw new Error("Secure desktop bridge unavailable.");
  window.installer.onProgress(handleProgress);
  const status = await window.installer.getStatus();
  definitions = status.providers;
  for (const [value, definition] of Object.entries(definitions)) {
    const label = document.createElement("label");
    label.className = "provider";
    const input = document.createElement("input");
    input.type = "radio";
    input.name = "provider";
    input.value = value;
    input.checked = value === "nanogpt";
    const caption = document.createElement("span");
    caption.textContent = definition.label.toUpperCase();
    label.append(input, caption);
    providers.append(label);
  }
  providers.addEventListener("change", (event) => chooseProvider(event.target.value));
  chooseProvider("nanogpt");
  document.querySelector("#runtime").textContent = `${status.node} / ${status.platform.toUpperCase()}`;
  document.querySelector("#system-status").textContent = "DESKTOP BRiDGE SECURE // READY";
  if (status.envExists) document.querySelector("#replace-row").classList.remove("hidden");
  addLog("PROBE", status.envExists ? "Existing .env detected; overwrite lock armed." : "Clean configuration slot found.", "OK");
  addLog("PROBE", status.promptExists ? "Private character prompt preserved." : "Safe starter prompt will be generated.", "OK");
}

form.addEventListener("input", updateMeter);
document.querySelector("#primary-api-key").addEventListener("input", () => scheduleModelLoad());
document.querySelector("#local-base-url").addEventListener("input", () => {
  if (new FormData(form).get("provider") === "local") scheduleModelLoad();
});
document.querySelector("#refresh-models").addEventListener("click", () => scheduleModelLoad(0));
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  errorBox.textContent = "";
  const data = Object.fromEntries(new FormData(form));
  if (!data.ownerId && !data.ownerUsername) {
    errorBox.textContent = "OWNER iD OR USERNAME REQUiRED.";
    return;
  }
  data.installCodex = form.elements.installCodex.checked;
  data.runtimeRestartEnabled = form.elements.runtimeRestartEnabled.checked;
  data.runTests = form.elements.runTests.checked;
  data.autobanEnabled = form.elements.autobanEnabled.checked;
  data.replaceExisting = form.elements.replaceExisting?.checked || false;
  const button = document.querySelector("#generate");
  button.disabled = true;
  button.querySelector("span").textContent = "GENERATiNG...";
  addLog("QUEUE", "Configuration validated in renderer. Handing off to the desktop process...");
  try {
    await window.installer.install(data);
  } catch (error) {
    errorBox.textContent = error.message.toUpperCase();
    addLog("FAULT", error.message, "ERR");
    button.disabled = false;
    button.querySelector("span").textContent = "GENERATE THE RiG";
  }
});

document.addEventListener("click", (event) => {
  const id = event.target.dataset.peek;
  if (!id) return;
  const input = document.querySelector(`#${id}`);
  input.type = input.type === "password" ? "text" : "password";
  event.target.textContent = input.type === "password" ? "ViEW" : "HiDE";
});

document.querySelector("#minimize").addEventListener("click", () => window.installer.minimize());
document.querySelector("#close").addEventListener("click", () => window.installer.close());

const ownerHelpDialog = document.querySelector("#owner-help-dialog");
document.querySelector("#owner-help").addEventListener("click", () => ownerHelpDialog.showModal());
document.querySelector("#owner-help-close").addEventListener("click", () => ownerHelpDialog.close());
document.querySelector("#owner-help-done").addEventListener("click", () => ownerHelpDialog.close());
ownerHelpDialog.addEventListener("click", (event) => {
  if (event.target === ownerHelpDialog) ownerHelpDialog.close();
});

boot().catch((error) => {
  document.querySelector("#system-status").textContent = "DESKTOP BRiDGE FAULT";
  errorBox.textContent = error.message;
  addLog("FAULT", error.message, "ERR");
});
