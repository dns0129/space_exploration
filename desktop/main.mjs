import { app, BrowserWindow, dialog, ipcMain, Menu, protocol, session, shell } from "electron";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { mkdir, stat } from "node:fs/promises";
import { DesktopSaveRepository } from "./save-repository.mjs";
import { createLocalProtocol, GAME_URL, isGameDocumentURL, isTrustedGameSender, parseCloseResult, parseUserDataDirectory } from "./local-protocol.mjs";

protocol.registerSchemesAsPrivileged([{ scheme: "voyager", privileges: {
  standard: true, secure: true, supportFetchAPI: true,
} }]);

const project = fileURLToPath(new URL("../", import.meta.url));
const preload = fileURLToPath(new URL("./preload.cjs", import.meta.url));
app.setName("星际探索");
try {
  app.setPath("userData", parseUserDataDirectory(process.argv, join(app.getPath("appData"), "星际探索")));
} catch (error) {
  dialog.showErrorBox("存档目录参数无效", error.message);
  app.exit(1);
}
if (!app.requestSingleInstanceLock()) app.exit(0);

let mainWindow;
let saves;
let closeRequested = false;
let finalizingClose = false;
let allowClose = false;
let closeTimer;
let showingCloseDialog = false;
const CLOSE_WAIT_MS = 12_000;

function trusted(event) {
  if (!isTrustedGameSender(event, mainWindow?.webContents)) throw new Error("此页面无法访问客户端存档。");
}

function clearClosing() {
  clearTimeout(closeTimer);
  closeTimer = undefined;
  closeRequested = false;
  finalizingClose = false;
}

function finishClose() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  clearTimeout(closeTimer);
  allowClose = true;
  mainWindow.close();
}

async function askAboutUnsaved(detail, timedOut = false) {
  if (showingCloseDialog || !mainWindow || mainWindow.isDestroyed()) return;
  showingCloseDialog = true;
  try {
    const answer = await dialog.showMessageBox(mainWindow, {
      type: "warning", title: timedOut ? "等待存档" : "存档失败",
      message: timedOut ? "退出前的航行存档尚未完成。" : "最新航行未能保存。",
      detail: `${detail}\n仍然退出可能丢失最近的航行进度。`,
      buttons: [timedOut ? "继续等待" : "取消退出", "仍然退出"], defaultId: 0, cancelId: 0,
    });
    if (answer.response === 1) finishClose();
    else if (timedOut && closeRequested) armCloseTimeout();
    else clearClosing();
  } finally { showingCloseDialog = false; }
}

function armCloseTimeout() {
  clearTimeout(closeTimer);
  closeTimer = setTimeout(() => void askAboutUnsaved("客户端响应或磁盘写入耗时较长，可继续等待或稍后重试。", true), CLOSE_WAIT_MS);
}

async function showBlockedLink() {
  if (mainWindow && !mainWindow.isDestroyed()) await dialog.showMessageBox(mainWindow, {
    type: "info", title: "外部链接", message: "客户端只显示本地游戏。",
    detail: "请使用“帮助”菜单，在默认浏览器中查看官方网站或源码。", buttons: ["知道了"],
  });
}

function createMenu() {
  const openHelp = async (url) => {
    // These fixed HTTPS URLs are opened only by a native user menu action.
    await shell.openExternal(url).catch(() => dialog.showErrorBox("无法打开浏览器", "请在浏览器中打开游戏官方网站。"));
  };
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: "星际探索", submenu: [
      { label: "关于星际探索", role: "about" }, { type: "separator" },
      { label: "退出星际探索", accelerator: "CommandOrControl+Q", click: () => mainWindow?.close() },
    ] },
    { label: "编辑", submenu: [{ label: "撤销", role: "undo" }, { label: "重做", role: "redo" },
      { type: "separator" }, { label: "剪切", role: "cut" }, { label: "复制", role: "copy" },
      { label: "粘贴", role: "paste" }, { label: "全选", role: "selectAll" }] },
    { label: "窗口", submenu: [
      { label: "切换全屏", role: "togglefullscreen" }, { label: "最小化", role: "minimize" },
      { label: "打开存档文件夹", click: async () => {
        await mkdir(app.getPath("userData"), { recursive: true });
        const error = await shell.openPath(app.getPath("userData"));
        if (error) dialog.showErrorBox("无法打开存档目录", "请检查本机文件访问权限。");
      } },
    ] },
    { label: "帮助", submenu: [
      { label: "游戏官方网站", click: () => void openHelp("https://dns0129.github.io/space_exploration/") },
      { label: "查看游戏源码", click: () => void openHelp("https://github.com/dns0129/space_exploration") },
    ] },
  ]));
}

async function createWindow() {
  await stat(join(project, "dist-desktop/index.html"));
  saves = new DesktopSaveRepository(app.getPath("userData"));
  session.defaultSession.protocol.handle("voyager", createLocalProtocol(join(project, "dist-desktop")));
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    let local = false;
    try {
      const url = new URL(details.url);
      local = (url.protocol === "voyager:" && url.host === "game") || ["data:", "blob:", "devtools:"].includes(url.protocol);
    } catch { /* malformed URLs are denied */ }
    callback({ cancel: !local });
  });
  mainWindow = new BrowserWindow({
    width: 1440, height: 960, minWidth: 960, minHeight: 700,
    title: "星际探索 · 远航 VOYAGER", backgroundColor: "#080c12", show: false,
    webPreferences: {
      preload, contextIsolation: true, sandbox: true, nodeIntegration: false,
      webSecurity: true, allowRunningInsecureContent: false, webviewTag: false,
    },
  });
  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.on("close", (event) => {
    if (allowClose) return;
    event.preventDefault();
    if (closeRequested) return;
    closeRequested = true;
    armCloseTimeout();
    mainWindow.webContents.send("voyager:window:before-close");
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (isGameDocumentURL(url)) return;
    event.preventDefault();
    void showBlockedLink();
  });
  mainWindow.webContents.on("will-frame-navigate", (event) => {
    if (!event.isMainFrame || !isGameDocumentURL(event.url)) event.preventDefault();
  });
  mainWindow.webContents.on("will-redirect", (event) => event.preventDefault());
  mainWindow.webContents.on("will-attach-webview", (event) => event.preventDefault());
  mainWindow.webContents.setWindowOpenHandler(() => { void showBlockedLink(); return { action: "deny" }; });
  createMenu();
  await mainWindow.loadURL(GAME_URL);
}

ipcMain.handle("voyager:save:read", (event) => { trusted(event); return saves.read(); });
ipcMain.handle("voyager:save:write", (event, value) => {
  trusted(event);
  if (finalizingClose) throw new Error("客户端正在退出，无法新增存档。");
  return saves.write(value);
});
ipcMain.handle("voyager:window:ready-close", async (event, value) => {
  trusted(event);
  const result = parseCloseResult(value);
  if (!closeRequested || finalizingClose) return;
  if (!result.saved) {
    clearTimeout(closeTimer);
    await askAboutUnsaved(result.message || "请检查存档目录的写入权限和磁盘空间。");
    return;
  }
  finalizingClose = true;
  try { await saves.flush(); finishClose(); }
  catch {
    finalizingClose = false;
    clearTimeout(closeTimer);
    await askAboutUnsaved("本机磁盘未能完成存档写入，请检查空间和权限。");
  }
});

app.on("window-all-closed", () => app.quit());
app.on("second-instance", () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});
app.whenReady().then(createWindow).catch((error) => {
  console.error("客户端启动失败：", error.message);
  dialog.showErrorBox("客户端无法启动", "未找到完整的游戏资源，或本机无法读取安装目录。开发模式请先构建桌面游戏资源。");
  app.exit(1);
});
