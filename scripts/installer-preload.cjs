const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("installer", {
  getStatus: () => ipcRenderer.invoke("installer:status"),
  listModels: (provider, apiKey, baseUrl) =>
    ipcRenderer.invoke("installer:list-models", { provider, apiKey, baseUrl }),
  install: (configuration) => ipcRenderer.invoke("installer:install", configuration),
  openExternal: (url) => ipcRenderer.invoke("installer:open-external", url),
  onProgress: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on("installer:progress", handler);
    return () => ipcRenderer.removeListener("installer:progress", handler);
  },
  minimize: () => ipcRenderer.send("window:minimize"),
  close: () => ipcRenderer.send("window:close"),
});
