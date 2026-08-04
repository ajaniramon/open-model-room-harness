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
const TRACK_CUE_SECONDS = 25;
const TRACK_VOLUME = 0.58;
const TRACK_FADE_MS = 2_200;

function formatTrackTime(seconds) {
  const safe = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  return `${String(Math.floor(safe / 60)).padStart(2, "0")}:${String(safe % 60).padStart(2, "0")}`;
}

function initKeygenBanner() {
  const banner = document.querySelector(".keygen-banner");
  const canvas = document.querySelector("#keygen-canvas");
  const context = canvas.getContext("2d", { alpha: false });
  const audio = document.querySelector("#soundtrack");
  const toggle = document.querySelector("#soundtrack-toggle");
  const action = document.querySelector("#soundtrack-action");
  const state = document.querySelector("#soundtrack-state");
  const clock = document.querySelector("#soundtrack-time");
  const credit = document.querySelector("#soundtrack-credit");
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let started = false;
  let fadeFrame = 0;
  let analyser = null;
  let spectrum = null;
  let audioContext = null;
  let source = null;

  let seed = 0x4f4d52;
  const random = () => {
    seed = (seed * 1_664_525 + 1_013_904_223) >>> 0;
    return seed / 0x1_0000_0000;
  };
  const stars = Array.from({ length: 74 }, () => ({
    x: random(),
    y: random() * 0.72,
    size: 0.35 + random() * 1.45,
    speed: 0.006 + random() * 0.018,
    phase: random() * Math.PI * 2,
  }));

  function resizeCanvas() {
    const bounds = canvas.getBoundingClientRect();
    const scale = Math.min(devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.round(bounds.width * scale));
    canvas.height = Math.max(1, Math.round(bounds.height * scale));
    context.setTransform(scale, 0, 0, scale, 0, 0);
  }

  function draw(timestamp = 0) {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const time = timestamp * 0.001;
    const horizon = height * 0.5;
    const gradient = context.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, "#02050a");
    gradient.addColorStop(0.5, "#081425");
    gradient.addColorStop(1, "#08030e");
    context.fillStyle = gradient;
    context.fillRect(0, 0, width, height);

    context.save();
    context.globalCompositeOperation = "screen";
    for (const star of stars) {
      const x = ((star.x + time * star.speed) % 1) * width;
      const pulse = 0.35 + Math.sin(time * 2.2 + star.phase) * 0.18;
      context.fillStyle = `rgba(157,236,255,${pulse})`;
      context.fillRect(x, star.y * height, star.size, star.size);
    }

    context.lineWidth = 0.65;
    for (let line = -16; line <= 16; line += 1) {
      const center = width * 0.54;
      context.strokeStyle = line % 4 === 0 ? "#e052c455" : "#52dce833";
      context.beginPath();
      context.moveTo(center + line * 7, horizon);
      context.lineTo(center + line * 76, height + 8);
      context.stroke();
    }
    for (let line = 0; line < 13; line += 1) {
      const phase = (line / 13 + time * 0.12) % 1;
      const y = horizon + phase * phase * (height - horizon + 10);
      context.strokeStyle = line % 3 === 0 ? "#e052c455" : "#52dce83d";
      context.beginPath();
      context.moveTo(0, y);
      context.lineTo(width, y);
      context.stroke();
    }

    if (analyser && spectrum) analyser.getByteFrequencyData(spectrum);
    const bars = 42;
    const barWidth = Math.max(2, width / bars - 3);
    for (let index = 0; index < bars; index += 1) {
      const signal = spectrum
        ? spectrum[Math.floor((index / bars) * spectrum.length)] / 255
        : 0.12 + (Math.sin(time * 2.4 + index * 0.72) + 1) * 0.045;
      const barHeight = 2 + signal * 27;
      context.fillStyle = index % 3 === 0 ? "#f05aca42" : "#5ce6ee3a";
      context.fillRect(index * (width / bars), horizon - barHeight, barWidth, barHeight);
    }
    context.restore();

    if (!reducedMotion) requestAnimationFrame(draw);
  }

  async function prepareAnalyser() {
    if (!audioContext) {
      audioContext = new AudioContext();
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 128;
      analyser.smoothingTimeConstant = 0.78;
      spectrum = new Uint8Array(analyser.frequencyBinCount);
      source = audioContext.createMediaElementSource(audio);
      source.connect(analyser);
      analyser.connect(audioContext.destination);
    }
    if (audioContext.state === "suspended") await audioContext.resume();
  }

  function cancelFade() {
    if (fadeFrame) cancelAnimationFrame(fadeFrame);
    fadeFrame = 0;
  }

  function fadeIn() {
    cancelFade();
    audio.volume = 0;
    const beganAt = performance.now();
    const step = (now) => {
      const progress = Math.min(1, (now - beganAt) / TRACK_FADE_MS);
      audio.volume = TRACK_VOLUME * (1 - Math.cos(progress * Math.PI)) / 2;
      if (progress < 1 && !audio.paused) fadeFrame = requestAnimationFrame(step);
      else fadeFrame = 0;
    };
    fadeFrame = requestAnimationFrame(step);
  }

  function updateClock() {
    const duration = Number.isFinite(audio.duration) ? audio.duration : 235;
    const current = started ? audio.currentTime : TRACK_CUE_SECONDS;
    clock.textContent = `${formatTrackTime(current)} / ${formatTrackTime(duration)}`;
  }

  async function playFromCurrentPosition() {
    await prepareAnalyser();
    if (!started || audio.ended || audio.currentTime < TRACK_CUE_SECONDS) {
      audio.currentTime = TRACK_CUE_SECONDS;
    }
    await audio.play();
    started = true;
    fadeIn();
  }

  toggle.addEventListener("click", async () => {
    try {
      if (audio.paused) await playFromCurrentPosition();
      else audio.pause();
    } catch (error) {
      state.textContent = "AUDIO FAULT";
      addLog("AUDIO", error.message || "Playback failed.", "ERR");
    }
  });
  credit.addEventListener("click", async () => {
    try {
      await window.installer.openExternal(credit.dataset.url);
    } catch (error) {
      addLog("LINK", error.message || "Could not open the track page.", "ERR");
    }
  });
  audio.addEventListener("play", () => {
    banner.classList.add("playing");
    toggle.setAttribute("aria-pressed", "true");
    toggle.setAttribute("aria-label", "Pause Silicon Dreamer");
    action.textContent = "PAUSE.MOD";
    state.textContent = "PLAYING";
  });
  audio.addEventListener("pause", () => {
    cancelFade();
    banner.classList.remove("playing");
    toggle.setAttribute("aria-pressed", "false");
    toggle.setAttribute("aria-label", "Play Silicon Dreamer");
    action.textContent = "PLAY.MOD";
    if (!audio.ended) state.textContent = started ? "PAUSED" : "CUE 00:25";
  });
  audio.addEventListener("loadedmetadata", () => {
    if (!started) audio.currentTime = Math.min(TRACK_CUE_SECONDS, audio.duration || TRACK_CUE_SECONDS);
    updateClock();
  });
  audio.addEventListener("timeupdate", updateClock);
  audio.addEventListener("ended", async () => {
    state.textContent = "RELOADING";
    audio.currentTime = TRACK_CUE_SECONDS;
    try {
      await playFromCurrentPosition();
    } catch (error) {
      state.textContent = "AUDIO FAULT";
      addLog("AUDIO", error.message || "Loop playback failed.", "ERR");
    }
  });
  audio.addEventListener("error", () => {
    state.textContent = "FILE MISSING";
  });

  new ResizeObserver(resizeCanvas).observe(banner);
  resizeCanvas();
  draw();
  updateClock();
}

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
// Passive capture is meaningless without memory, so it stays locked until memory is on.
document.querySelector("#enable-memory").addEventListener("change", (event) => {
  const capture = document.querySelector("#enable-memory-capture");
  capture.disabled = !event.target.checked;
  if (!event.target.checked) capture.checked = false;
});
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
  data.enableMemory = form.elements.enableMemory.checked;
  data.enableMemoryCapture = form.elements.enableMemoryCapture.checked;
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

initKeygenBanner();
boot().catch((error) => {
  document.querySelector("#system-status").textContent = "DESKTOP BRiDGE FAULT";
  errorBox.textContent = error.message;
  addLog("FAULT", error.message, "ERR");
});
