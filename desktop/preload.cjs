const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("voyagerDesktop", {
  version: 1,
  readSave: () => ipcRenderer.invoke("voyager:save:read"),
  writeSave: (state) => ipcRenderer.invoke("voyager:save:write", state),
  onBeforeClose: (callback) => {
    if (typeof callback !== "function") throw new TypeError("关闭通知需要回调函数。");
    // Never expose Electron's event object or IPC transport to the renderer.
    const listener = () => callback();
    ipcRenderer.on("voyager:window:before-close", listener);
    return () => ipcRenderer.removeListener("voyager:window:before-close", listener);
  },
  readyToClose: (result) => ipcRenderer.invoke("voyager:window:ready-close", result),
});
