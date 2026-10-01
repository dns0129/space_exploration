import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { build } from "vite";

const project = fileURLToPath(new URL("../", import.meta.url));
const filename = "voyager-flight.html";
const textures = {};
for (const file of [
  "earth-day.jpg",
  "earth-night.jpg",
  "earth-height.jpg",
  "earth-water.png",
  "earth-clouds.png",
]) {
  const bytes = await readFile(join(project, "public/textures", file));
  const type = file.endsWith(".png") ? "image/png" : "image/jpeg";
  textures[file] = `data:${type};base64,${bytes.toString("base64")}`;
}

const result = await build({
  configFile: false,
  root: project,
  base: "./",
  publicDir: false,
  plugins: [
    {
      name: "standalone-local-textures",
      enforce: "pre",
      transform(code, id) {
        if (!id.endsWith("/src/planet-scene.ts")) return;
        const location = "`${import.meta.env.BASE_URL}textures/${file}`";
        if (!code.includes(location))
          throw new Error("Texture loader changed; update the export adapter.");
        return {
          code: code.replace(location, `(${JSON.stringify(textures)})[file]`),
          map: null,
        };
      },
    },
  ],
  build: {
    write: false,
    modulePreload: false,
    reportCompressedSize: false,
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});

if (Array.isArray(result)) throw new Error("Expected one application output.");
const chunks = result.output.filter((item) => item.type === "chunk");
if (
  chunks.length !== 1 ||
  chunks[0].imports.length ||
  chunks[0].dynamicImports.length
) {
  throw new Error(
    "Standalone application must have no external JavaScript imports.",
  );
}
const htmlAsset = result.output.find(
  (item) => item.type === "asset" && item.fileName === "index.html",
);
const cssAsset = result.output.find(
  (item) => item.type === "asset" && item.fileName.endsWith(".css"),
);
if (!htmlAsset || !cssAsset)
  throw new Error("Application HTML or styles are missing.");
const source = (item) =>
  typeof item.source === "string"
    ? item.source
    : Buffer.from(item.source).toString("utf8");
let html = source(htmlAsset);
const script = chunks[0].code.replace(/<\/script/gi, "<\\/script");
html = html.replace(
  /<script\b[^>]*\bsrc="[^"]+"[^>]*>\s*<\/script>/,
  () => `<script type="module">${script}</script>`,
);
html = html.replace(
  /<link\b(?=[^>]*\brel="stylesheet")[^>]*>/,
  () => `<style>${source(cssAsset)}</style>`,
);
const favicon = await readFile(join(project, "public/favicon.svg"));
html = html.replace(
  /<link\b(?=[^>]*\brel="icon")[^>]*>/,
  () =>
    `<link rel="icon" href="data:image/svg+xml;base64,${favicon.toString("base64")}">`,
);

const instructions = `远航 VOYAGER · 自由航行（阶段 03）

立即驾驶：解压后将 voyager-flight.html 拖入 Chrome 或 Edge。
点击顶部“自由航行”，从当前行星附近出发。
W/S 推力，A/D 平移，R/F 升降，Q/E 翻滚，方向键或拖动转向。
Shift 加速，空格刹车，C 切换座舱/外部视角。手机使用触屏驾驶按钮。
点击天体导航选择目的地；“对准目标”调整航向，“跃迁至目标”快速抵达。
可以暂停航行、保存与恢复；无需服务器的独立 HTML 使用本机存档。

后端模式（服务端存档）：
安装 Node.js 24 LTS，然后在本目录运行：
node server/server.mjs --standalone
Windows 可双击“启动航行.bat”；macOS/Linux 可执行 bash 启动航行.sh。
服务启动后在浏览器访问 http://127.0.0.1:3000/
后端和游戏全部随包提供，不需要 npm 安装依赖。
航行存档保存在 data/ 中，浏览器用自己的会话识别存档。
不要删除浏览器会话 Cookie；重新启动服务器后仍可恢复同一浏览器的存档。

全部 4K 地球贴图、程序和样式已内嵌。浏览器需要 WebGL 2 与图形加速；性能不足时选择标准画质。
天体尺寸与距离经过压缩，采用简化惯性、驾驶辅助与防撞护盾，不模拟真实轨道力学。
地球使用影像贴图，其余天体是程序化艺术材质。
源码与素材来源：https://github.com/dns0129/space_exploration
`;
const windowsStart =
  '@echo off\r\nchcp 65001 >nul\r\ncd /d "%~dp0"\r\nwhere node >nul 2>nul\r\nif errorlevel 1 (echo 请先安装 Node.js 24 LTS & pause & exit /b 1)\r\necho 浏览器打开 http://127.0.0.1:3000/\r\nnode server/server.mjs --standalone\r\npause\r\n';
const unixStart =
  '#!/usr/bin/env bash\nset -euo pipefail\ncd "$(dirname "$0")"\necho "Open http://127.0.0.1:3000/ after the server starts."\nexec node server/server.mjs --standalone\n';

// ZIP records keep export portable without Python or an archiver.
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function archive(entries) {
  const files = [],
    directory = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const path = Buffer.from(name);
    const bytes = Buffer.from(content);
    const compressed = deflateRawSync(bytes, { level: 9 });
    const crc = crc32(bytes);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6); // UTF-8 filenames.
    header.writeUInt16LE(8, 8);
    header.writeUInt16LE(0x5d41, 12); // 2026-10-01, deterministic export date.
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(bytes.length, 22);
    header.writeUInt16LE(path.length, 26);
    files.push(header, path, compressed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    header.copy(central, 6, 4, 28);
    central.writeUInt32LE(offset, 42);
    directory.push(central, path);
    offset += header.length + path.length + compressed.length;
  }
  const index = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(index.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...files, index, end]);
}

await mkdir(join(project, "dist-standalone"), { recursive: true });
await mkdir(join(project, "downloads"), { recursive: true });
await writeFile(join(project, "dist-standalone", filename), html);
const zip = archive([
  [filename, html],
  ["中文打开说明.txt", instructions],
  ["启动航行.bat", windowsStart],
  ["启动航行.sh", unixStart],
  ["server/server.mjs", await readFile(join(project, "server/server.mjs"))],
  [
    "shared/flight-state.mjs",
    await readFile(join(project, "shared/flight-state.mjs")),
  ],
  ["shared/world.json", await readFile(join(project, "shared/world.json"))],
]);
await writeFile(join(project, "downloads/voyager-flight.zip"), zip);
console.log(
  `Exported ${filename} (${(Buffer.byteLength(html) / 1024 / 1024).toFixed(1)} MiB) and downloads/voyager-flight.zip (${(zip.length / 1024 / 1024).toFixed(1)} MiB).`,
);
