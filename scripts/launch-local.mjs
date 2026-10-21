import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const project = fileURLToPath(new URL("../", import.meta.url));
const gamePort = Number(process.env.VOYAGER_GAME_PORT ?? 5173);
const origin = `http://127.0.0.1:${gamePort}`;
const apiPort = Number(process.env.VOYAGER_API_PORT ?? 3000);
const noOpen = process.argv.includes("--no-open");
let api;
let vite;
let stopping = false;

async function stop() {
  if (stopping) return;
  stopping = true;
  await vite?.close();
  if (api?.listening) await new Promise(resolve => api.close(resolve));
}

function occupied(port) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", error => {
      if (error.code === "ECONNREFUSED") resolve(false);
      else reject(error);
    });
    socket.setTimeout(1500, () => {
      socket.destroy();
      reject(new Error(`检查端口 ${port} 超时。`));
    });
  });
}

async function ready() {
  try {
    const [page, health] = await Promise.all([
      fetch(origin, { signal: AbortSignal.timeout(1500) }),
      fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1500) }),
    ]);
    const [html, status] = await Promise.all([page.text(), health.json()]);
    return page.ok && health.ok && html.includes("VOYAGER")
      && html.includes("/src/main.ts") && status.status === "ok";
  } catch {
    return false;
  }
}

function openGame() {
  if (noOpen) return;
  const browser = spawn("rundll32.exe", ["url.dll,FileProtocolHandler", origin], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  browser.once("error", error => {
    console.error(`未能自动打开浏览器：${error.message}\n请手动访问 ${origin}`);
  });
  browser.unref();
}

async function main() {
  if (Number(process.versions.node.split(".")[0]) < 24)
    throw new Error("请安装 Node.js 24 LTS 或更新版本后再启动。 ");
  if (![gamePort, apiPort].every(port => Number.isInteger(port) && port > 0 && port <= 65535)
    || gamePort === apiPort)
    throw new Error("游戏与存档后端端口必须是 1–65535 之间的两个不同端口。");

  if (await occupied(gamePort)) {
    if (!await ready())
      throw new Error(`端口 ${gamePort} 已被其他程序占用，或已有服务尚未就绪。请关闭对应服务后重试。`);
    console.log(`游戏服务已在运行，直接打开：${origin}`);
    openGame();
    return;
  }
  if (await occupied(apiPort))
    throw new Error(`存档后端端口 ${apiPort} 已被占用。请关闭对应服务后重试。`);

  console.log("正在启动游戏和本机存档服务……");
  console.log("请保留此窗口。按 Ctrl+C 或关闭此窗口可停止服务。");
  const [{ createVoyagerServer }, { createServer }] = await Promise.all([
    import("../server/server.mjs"), import("vite"),
  ]);
  api = createVoyagerServer();
  await new Promise((resolve, reject) => {
    api.once("error", reject);
    api.listen(apiPort, "127.0.0.1", resolve);
  });
  process.env.VOYAGER_API_PORT = String(apiPort);
  vite = await createServer({
    root: project,
    server: { host: "127.0.0.1", port: gamePort, strictPort: true },
  });
  await vite.listen();
  process.on("SIGINT", () => { void stop(); });
  process.on("SIGTERM", () => { void stop(); });

  for (let attempt = 0; attempt < 120; attempt++) {
    if (stopping) return;
    if (await ready()) {
      console.log(`游戏已就绪：${origin}`);
      openGame();
      return;
    }
    await delay(500);
  }
  throw new Error("启动超时，请查看上方错误信息。");
}

main().catch(async error => {
  console.error(error.message);
  process.exitCode = 1;
  await stop();
});
