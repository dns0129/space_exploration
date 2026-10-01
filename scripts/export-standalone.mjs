import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { build } from "vite";

const project = fileURLToPath(new URL("../", import.meta.url));
const filename = "voyager-solar-system.html";
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

const instructions = `远航 VOYAGER · 太阳系观测站（阶段 02）

1. 解压本 ZIP 文件。
2. 将 ${filename} 拖入 Chrome 或 Edge，或用浏览器打开这个 HTML。
3. 点击天体导航切换太阳、水星、金星、地球、火星、木星、土星、天王星、海王星。

全部程序、样式和地球高清贴图已内嵌；其他天体使用程序化材质，无需服务器或联网。
拖动环绕，滚轮缩放；空格暂停自转，R 重置，H 打开操作指南。
手机上使用单指环绕、双指缩放，并点击“观测设置”调整画质和图层。
如设备性能有限，可切换标准画质。浏览器需支持 WebGL 2 并启用图形加速。

本阶段优先建设星球画面。各天体按单独展示比例呈现，自转为加速演示；尚未模拟飞船与轨道力学。
地球影像来源见游戏中的“操作指南 → 影像与素材来源”及仓库 ASSETS.md。
其余天体为艺术化程序材质，并非实测影像。

源码与后续更新：https://github.com/dns0129/space_exploration
`;

// Two small-entry ZIP records keep export portable without Python or an archiver.
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
]);
await writeFile(join(project, "downloads/voyager-solar-system.zip"), zip);
console.log(
  `Exported ${filename} (${(Buffer.byteLength(html) / 1024 / 1024).toFixed(1)} MiB) and downloads/voyager-solar-system.zip (${(zip.length / 1024 / 1024).toFixed(1)} MiB).`,
);
