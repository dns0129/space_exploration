import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { build } from "vite";

const project = fileURLToPath(new URL("../", import.meta.url));
const filename = "voyager-warp.html";
// The standalone browser and optional backend read one embedded height dataset.
// Keep their physical geology identical without duplicating several MiB in ZIP.
const terrainModule = await readFile(join(project, "shared/terrain-fields.mjs"), "utf8");
const rasterDeclaration = terrainModule.match(/^const rasterDefinitions = (\{[^\n]+\});$/m);
if (!rasterDeclaration) throw new Error("Canonical terrain format changed; update the export adapter.");
const terrainJson = rasterDeclaration[1];
JSON.parse(terrainJson);
const terrainMarker = '<script id="canonical-height-data" type="application/json">';
const backendTerrainModule = 'import { openSync, readSync, closeSync } from "node:fs";\n' + terrainModule.replace(rasterDeclaration[0], `
const rasterDefinitions = (() => {
  const file = openSync(new URL("../${filename}", import.meta.url), "r");
  const chunk = Buffer.alloc(256 * 1024), marker = ${JSON.stringify(terrainMarker)};
  let prefix = "";
  try {
    for (;;) {
      const size = readSync(file, chunk, 0, chunk.length, null);
      if (!size) throw new Error("Canonical terrain dataset is missing from the game document.");
      prefix += chunk.toString("utf8", 0, size);
      const start = prefix.indexOf(marker);
      if (start < 0) { prefix = prefix.slice(-marker.length); continue; }
      const end = prefix.indexOf("</script>", start + marker.length);
      if (end >= 0) return JSON.parse(prefix.slice(start + marker.length, end));
    }
  } finally { closeSync(file); }
})();`);
// Canonical height fields are embedded in shared code. Old DEM PNGs and the
// replaced per-system panorama remain in public provenance, but are not loaded.
const retiredTextures = new Set(["earth-terrain-4k.png", "earth-terrain-8k.png", "centauri-milky-way-4k.jpg"]);
const textures = {};
for (const file of (await readdir(join(project, "public/textures"))).filter((file) => /\.(jpg|png)$/.test(file) && !retiredTextures.has(file)).sort()) {
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
        if (id.endsWith("/shared/terrain-fields.mjs")) return {
          code: code.replace(rasterDeclaration[0], 'const rasterDefinitions = JSON.parse(document.getElementById("canonical-height-data").textContent);'),
          map: null,
        };
        if (!id.endsWith("/src/planet-scene.ts")) return;
        const location = "`${import.meta.env.BASE_URL}textures/${file}`";
        if (!code.includes(location))
          throw new Error("Texture loader changed; update the export adapter.");
        return {
          code: `const inlineTextureAssets = ${JSON.stringify(textures)};\n` + code.replaceAll(location, "inlineTextureAssets[file]"),
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
  () => `${terrainMarker}${terrainJson.replace(/</g, "\\u003c")}</script><script type="module">${script}</script>`,
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

const instructions = `远航 VOYAGER · 太阳系、半人马座 α、参宿四、地表着陆与离舱探索（阶段 06）

立即驾驶：解压后将 voyager-warp.html 拖入 Chrome 或 Edge。
点击顶部“自由航行”，从当前行星附近出发。
W 前进，S 减速（停稳后倒车），A/D 平移，R/F 升降，Q/E 翻滚，方向键转向；触屏按住拖动，松手回正。
Shift 加速，空格刹车，C 切换座舱/外部视角，J 启动跃迁，O 启动近地轨道引擎，L 自动着陆/起飞/中止。手机使用触屏驾驶按钮。
选择并靠近岩石行星或卫星，按 L 连续下降并展开起落架；着陆后 L 或 R 起飞，升至离地 2 km 恢复手动驾驶。空格或手动操纵中止自动下降/起飞，暂停冻结进度。太阳和巨行星没有可着陆的固体地表。
落地后按 E 离舱；WASD 行走，Shift 奔跑，空格跳跃，方向键或拖动看向，C 切换第一/第三人称。落地且距离停泊点12m内按E返舱，返舱后再L/R起飞。不同天体重力改变跳跃高度、滞空与抓地；极低重力有宇航服回落辅助。人物位置、速度、腾空和视角支持保存恢复。徒步场景用24m登陆艇表示返舱入口，飞行船停泊坐标不变。
远处、近观与落地后使用同一球面材质和地貌位置，34个固体天体的轨道表面、地表网格、着陆与徒步碰撞共用高度场。地球使用1024×512的GEBCO高度与海陆分类；其他天体使用512×256影像明暗推断高度或固定程序坑场，属于游戏示意，16K颜色材质不代表16K测绘高程。土卫一的Herschel大坑保留几何坑底和坑沿。旧版有效着陆/徒步存档恢复时贴合新地表，保留表面方向和离地高度。
地球100km已进入稀薄大气，蓝色地平线与天空散射随下降逐步增强、星空逐步淡出，晨昏出现暖色散射；外部镜头保持飞船附近的高度。光学密度为游戏美术参数，大气阻力仍按稀薄高空密度计算。辅助驾驶补偿近地重力；关闭后需自行施加升力。
仅离固体地表10000m以内使用低速引擎；“航速与引擎”用滑块或数字手动调1–1000m/s，施加推力时达到所选速度上限，空格可刹停。超过10km后引擎档位至少1km/s，低速预设不生效，大气内巡航为1km/s。离地超过10000m、船头朝太空且没有向内漂移时，按O显式启动向太空离地；大气内仍限1km/s。离开后太空常规最高10000km/s，100000km/s须在面板手动选择星际高档，Shift不会自动切高档。设置随存档保存。
距天体1000km的真空安全区未显式向外离地时最高100km/s；大气限速优先，高速扫掠会制动。大气内及1000km内禁止跃迁。自动着陆也遵守气内限速。
卫星导航提供月球及木星 4、土星 8、天王星 5、海王星 8 颗主要卫星。火星和月球使用原生8K影像，触屏、低内存或GPU纹理上限不足时使用4K；其他有探测器影像的卫星使用 4K/2K 实测全球影像，海王星小卫星与海卫二使用 4K 高清概念图；半径及平均轨道距离采用公里比例，位置为静态示意。减速时显示琥珀色制动脉冲。
“恒星系统”切换太阳系、半人马座 α 或参宿四的导航目标，再选择天体。半人马座包含南门二 A/B、比邻星，以及比邻星 b、c、d；c/d 标记为候选行星。系外行星的半径、地表与大气是游戏示意。
参宿四目前仅包含一颗红超巨星，半径约 764 个太阳半径，距离约 548 光年；参数仍有观测不确定性。原生 8K 表面表现巨型对流胞，紧凑设备使用 4K 版本；均为原创艺术示意，恒星不能着陆。参宿四复用银河全景并单独设置方向与亮度。
半人马座三颗恒星与比邻星 b/c/d 使用 4K 高清概念图，不是实测照片。各航区共享真实8K/4K银河全景，实际跃迁与存档恢复会自动切换观察方向与亮度；程序星点是美术细节，不是天文星表。跨系统距离以光年显示。
全部43个球形天体支持16384×8192（16K）表面材质。地球保留原生16K影像，其他天体在原有2K/4K/8K影像或谷神星程序底色上合成16K增强分块；新增岩石纹理、冰面裂隙、气态云丝与恒星颗粒来自AI素材和固定天体种子，属于游戏美术。远处过滤与近处缓存采样同一材质函数，进入地表继续沿用当前天体的影像与分块。桌面高清/超清近观距中心三倍半径内生成缓存，GPU需要支持2064像素；有效区域2048×2048加四周8像素边界，最多驻留四块。手机、低内存或标准画质保留较轻影像与相同地貌；空间站使用结构模型。全部素材和高度数据随包提供，断网可用。
地球具有1.6–6.5km低空积云、7.8–15.5km入气云层和21km薄卷云，蓝天、浅色地平线、太阳盘与晨昏散射连续衔接。星球内和太空使用独立场景，每帧只更新当前模式；星球内暂停无关全球模型，允许当前天体的基础影像、材质和16K缓存更新，地形按需生成。精细船体有实体装甲缝、曲面座舱、涡轮喷口与柔和尾焰。
飞船船体长 10 km，与星球共用公里比例；地表附近使用起落架参考点与近地观察镜头。
点击天体导航选择目的地；“启动跃迁”蓄能、穿越航道，在星球仍很小时开始直线减速，星球随实际距离连续放大，航道光效逐渐淡出，可暂停或中止。末段保持朝向和翻滚，不自动调平或转向地平线。抵达侧保留出发方向；岩石行星通常距表面约 1100 km，巨行星和土星环系保留安全余量。
可以暂停航行、保存与恢复；无需服务器的独立 HTML 使用本机存档。

后端模式（服务端存档）：
安装 Node.js 24 LTS，然后在本目录运行：
node server/server.mjs --standalone
Windows 可双击“启动航行.bat”；macOS/Linux 可执行 bash 启动航行.sh。
服务启动后在浏览器访问 http://127.0.0.1:3000/
后端和游戏全部随包提供，不需要 npm 安装依赖。
航行存档保存在 data/ 中，浏览器用自己的会话识别存档。
不要删除浏览器会话 Cookie；重新启动服务器后仍可恢复同一浏览器的存档。

原生16K地球分块、所有其他球形天体的16K增强生成素材、8K/4K地球图层与银河全景、太阳、行星、卫星和半人马座天体的基础贴图、程序和样式已内嵌；放大时使用平滑过滤与细节叠加。浏览器需要WebGL 2与图形加速；超清、高清与标准均按持续帧耗时自动调整画面分辨率；性能不足时可选择标准画质停用增强分块。
天体半径和平均日距使用真实公里比例；太阳系行星和谷神星采用参考轨道倾角与升交点方向，小行星带具有立体分布。卫星随母星平移，旧版天体附近的航行、着陆和徒步存档支持布局迁移。方位仍是静态圆轨道示意，不是实时星历，尚未模拟公转或真实轨道力学；飞船采用简化惯性、驾驶辅助与防撞护盾。
银河全景与各天体使用影像贴图及简化着色；素材来源、修改和许可见 ASSETS.md 与 THIRD_PARTY_NOTICES.md。
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
    header.writeUInt16LE(0x5d42, 12); // 2026-10-02, deterministic export date.
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
  ["shared/surface.mjs", await readFile(join(project, "shared/surface.mjs"))],
  ["shared/terrain-fields.mjs", backendTerrainModule],
  ["ASSETS.md", await readFile(join(project, "ASSETS.md"))],
  ["THIRD_PARTY_NOTICES.md", await readFile(join(project, "THIRD_PARTY_NOTICES.md"))],
  ["public/textures/provenance.json", await readFile(join(project, "public/textures/provenance.json"))],
]);
if (zip.length >= 100 * 1024 * 1024) throw new Error("Offline ZIP exceeds GitHub's 100 MiB file limit.");
await writeFile(join(project, "downloads/voyager-warp.zip"), zip);
console.log(
  `Exported ${filename} (${(Buffer.byteLength(html) / 1024 / 1024).toFixed(1)} MiB) and downloads/voyager-warp.zip (${(zip.length / 1024 / 1024).toFixed(1)} MiB).`,
);
