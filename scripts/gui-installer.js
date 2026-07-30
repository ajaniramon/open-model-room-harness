import { app, BrowserWindow, ipcMain, session } from "electron";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  envPath,
  pathExists,
  performSetup,
  promptPath,
  providerDefinitions,
  root,
  validateSetup,
} from "./setup-core.js";
import { listProviderModels } from "./model-catalog.js";

let mainWindow;
let installing = false;
const captureArgument = process.argv.find((argument) => argument.startsWith("--capture="));
const capturePath = captureArgument?.slice("--capture=".length);
const installerUserData = mkdtempSync(join(tmpdir(), "open-model-room-installer-"));

app.setPath("userData", installerUserData);
app.commandLine.appendSwitch("disable-http-cache");
process.on("exit", () => {
  try {
    rmSync(installerUserData, { recursive: true, force: true });
  } catch {
    // Windows may retain a short-lived Chromium lock; the OS temp cleaner will recover it.
  }
});

function safeSend(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

ipcMain.handle("installer:status", async () => ({
  node: process.version,
  platform: process.platform,
  envExists: await pathExists(envPath),
  promptExists: await pathExists(promptPath),
  providers: providerDefinitions,
}));

ipcMain.handle("installer:install", async (_event, input) => {
  if (installing) throw new Error("Installation is already running.");
  const config = validateSetup(input);
  installing = true;
  void performSetup(config, (stage, message) =>
    safeSend("installer:progress", { stage, message, state: "RUN" }),
  )
    .then(() =>
      safeSend("installer:progress", {
        stage: "DONE",
        message: "RIG ARMED. Close this window and run npm start.",
        state: "OK",
      }),
    )
    .catch((error) =>
      safeSend("installer:progress", {
        stage: "FAULT",
        message: error.message || "Setup failed.",
        state: "ERR",
      }),
    )
    .finally(() => {
      installing = false;
    });
  return { accepted: true };
});

ipcMain.handle("installer:list-models", async (_event, input) => {
  if (!input || typeof input !== "object") throw new Error("Invalid model catalog request.");
  return listProviderModels(input.provider, input.apiKey);
});

ipcMain.on("window:minimize", () => mainWindow?.minimize());
ipcMain.on("window:close", () => {
  if (!installing) mainWindow?.close();
});

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1160,
    height: 820,
    minWidth: 880,
    minHeight: 680,
    show: !capturePath,
    frame: false,
    backgroundColor: "#090b10",
    title: "Open Model Room — Install Console",
    webPreferences: {
      preload: resolve(import.meta.dirname, "installer-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !app.isPackaged,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  await mainWindow.loadFile(resolve(root, "installer", "index.html"));

  if (capturePath) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 800));
    const image = await mainWindow.webContents.capturePage();
    const outputPath = resolve(capturePath);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, image.toPNG());
    app.quit();
  }
}

app
  .whenReady()
  .then(async () => {
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) =>
      callback(false),
    );
    await createWindow();
  })
  .catch((error) => {
    console.error(`Desktop installer failed to start: ${error.message}`);
    app.exit(1);
  });

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow();
});
