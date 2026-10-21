import { build } from 'vite';
import { readFile, writeFile, mkdir, readdir, copyFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { archive } from './archive.mjs';

const project = fileURLToPath(new URL('../', import.meta.url));
const root = join(project, 'dist-directory');
await rm(root, { recursive: true, force: true });
await build({ root: project, base: './', build: { outDir: join(root, 'game'), emptyOutDir: true } });
for (const file of ['surface-material-atlas.jpg','centauri-milky-way-4k.jpg'])
  await rm(join(root, 'game/textures', file), { force: true });
await mkdir(join(root,'server'), { recursive: true });
await copyFile(join(project,'server/server.mjs'),join(root,'server/server.mjs'));
await mkdir(join(root,'shared'), { recursive: true });
for (const file of await readdir(join(project,'shared'))) if (/\.(mjs|json)$/.test(file))
  await copyFile(join(project,'shared',file),join(root,'shared',file));
for (const file of ['ASSETS.md','THIRD_PARTY_NOTICES.md']) await copyFile(join(project,file),join(root,file));
await writeFile(join(root,'启动航行.bat'), '@echo off\r\nchcp 65001 >nul\r\ncd /d "%~dp0"\r\nnode server/server.mjs --directory\r\npause\r\n');
await writeFile(join(root,'启动航行.sh'), '#!/usr/bin/env bash\nset -euo pipefail\ncd "$(dirname "$0")"\nexec node server/server.mjs --directory\n');
await writeFile(join(root,'中文打开说明.txt'), '远航 VOYAGER · 资源目录版\n\n安装 Node.js 24 LTS 后，在解压目录双击“启动航行.bat”（Windows），或执行 bash 启动航行.sh（macOS/Linux）。浏览器访问 http://127.0.0.1:3000/。\n请通过启动器打开，不直接双击 game/index.html。无需 npm 安装或联网。\n\n完整素材随包提供，地形、物理引擎和贴图按使用场景读取，避免一次解析巨大的单文件 HTML。顶部齿轮提供即时画质设置，存档在 data/，备用存档在当前浏览器。源图片作者与许可见 ASSETS.md 与 THIRD_PARTY_NOTICES.md。\n');
const entries = [];
for (const file of (await readdir(root, { recursive: true })).sort()) if (/\.[^/]+$/.test(file))
  entries.push([file.replaceAll('\\','/'),await readFile(join(root,file))]);
const zip = archive(entries);
await mkdir(join(project,'dist-standalone'), { recursive: true });
await writeFile(join(project,'dist-standalone/voyager-directory.zip'),zip);
console.log(`Exported resource directory package (${(zip.length/1048576).toFixed(1)} MiB); ${entries.length} files.`);
