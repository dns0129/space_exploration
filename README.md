# 远航 VOYAGER

**阶段 03：自由航行。** 在一个连续的 3D 太阳系中驾驶飞船，环绕太阳和八颗行星，自由加速、平移、升降与翻滚；可使用座舱或外部视角。Node.js 后端提供世界配置和航行存档，原有高清行星观测功能保留。

## 下载即玩

下载 [自由航行游戏包](https://github.com/dns0129/space_exploration/raw/refs/heads/main/downloads/voyager-flight.zip)，解压后将 **`voyager-flight.html`** 拖入 Chrome 或 Edge。点击顶部“自由航行”，再按 **W** 出发。

独立 HTML 内嵌全部程序、样式与地球的五张 4K 贴图，无需安装 Node.js 或联网即可驾驶；保存与恢复使用本机存档。浏览器需要 WebGL 2 与图形加速。

若直接链接未下载，可打开 [文件页面](https://github.com/dns0129/space_exploration/blob/main/downloads/voyager-flight.zip) 点击下载。旧 `voyager-solar-system.zip` 与 `voyager-earth.zip` 保留为前两阶段存档，不包含自由航行。

![地球附近的飞船座舱](docs/screenshots/flight-cockpit.png)

![土星附近的外部飞船视角](docs/screenshots/flight-saturn.png)

[查看手机驾驶画面](docs/screenshots/flight-mobile.png)。

## 使用包内后端

游戏包同时包含可独立运行的后端。安装 **Node.js 24 LTS** 后，在解压目录运行：

```sh
node server/server.mjs --standalone
```

Windows 可双击 `启动航行.bat`；macOS/Linux 可运行 `bash 启动航行.sh`。服务启动后在本机浏览器访问 `http://127.0.0.1:3000/`，使用服务端保存、恢复航行。后端全部采用 Node.js 内置模块，无需 `npm install`。

存档保存在解压目录的 `data/` 中。每个浏览器通过一个 HttpOnly 会话 Cookie 识别自己的存档；刷新页面或重启服务器后可恢复同一浏览器的航行。关闭服务器使用 Ctrl+C。独立文件与服务器页面属于不同浏览器来源，各自的存档独立。

## 驾驶操作

| 操作                | 按键              |
| ------------------- | ----------------- |
| 前进推力 / 反向推力 | W / S             |
| 左右平移            | A / D             |
| 升降                | R / F             |
| 翻滚                | Q / E             |
| 转向、抬头与低头    | 鼠标拖动 / 方向键 |
| 加速                | 按住 Shift        |
| 刹车                | 按住空格          |
| 切换座舱 / 外部视角 | C                 |
| 操作指南            | H                 |

手机使用左侧推力、升降、平移与翻滚按钮，右侧转向和加速按钮，也可直接拖动场景转向。点顶部“行星观测”返回原有观察模式。

点击天体导航选择目的地：**对准目标**调整飞船朝向，再施加推力前往；**跃迁至目标**直接到目标附近，方便跨越较远距离。选择目的地不会替代手动驾驶。

驾驶辅助默认开启，使速度逐渐衰减；关闭后保持惯性滑行。暂停航行会冻结飞船，切换到后台时自动暂停。护盾会在接近行星或太阳时制动，高速运动也不会直接穿过行星。航速、最近天体、高度、航向、时间和目标距离实时更新。

可手动保存或恢复位置、速度、朝向、目的地、视角、辅助状态与航行时间；每 20 秒自动保存，退出航行时也保存。服务端不可用时使用本机存储。

## 开发运行

需要 Node.js 24 LTS 与 npm。无需数据库、API 密钥或外部素材服务。

```sh
cd /workspace/space_exploration
npm ci
npm run dev -- --port 5173 --strictPort
```

该命令同时启动后端（默认本机 3000）和 Vite（5173），Vite 将 `/api` 请求代理给后端。可通过 `VOYAGER_API_PORT` 更改开发后端端口。云环境内部地址仅供开发验证，不是用户可访问的公开站点。

```sh
npm run build        # TypeScript 检查与生产构建，输出 dist/
npm start            # 后端同时提供 dist/ 游戏页面与 API，默认本机 3000
npm test             # 桌面与移动浏览器功能和实际渲染验证
npm run test:server  # HTTP、持久存档、输入验证和航行动力学检查
npm run export       # 生成独立 HTML 及包含后端的 ZIP
npm run test:offline # 导出并验证断网驾驶、跃迁、本机保存与恢复
```

后端可通过 `PORT` 修改端口、`VOYAGER_HOST` 修改绑定地址、`VOYAGER_DATA_DIR` 修改存档目录。生产模式直接用 `npm start` 提供页面与 API；Vite preview 仅预览静态构建，不包含存档后端。

## 后端接口

| 接口                    | 功能                             |
| ----------------------- | -------------------------------- |
| `GET /api/health`       | 服务状态                         |
| `GET /api/world`        | 九个天体位置、展示半径与驾驶参数 |
| `GET /api/flight/save`  | 当前浏览器的航行存档             |
| `POST /api/flight/save` | 校验并保存当前航行状态           |

保存请求必须是 JSON，大小不超过 8 KiB；校验坐标、速度、单位四元数、目的地等字段。存档按会话隔离，写入使用临时文件和原子替换，同一会话的写入按顺序完成。后端负责配置与持久保存，浏览器实时计算驾驶和碰撞，保持控制响应。

## 星球外观与范围

太阳、水星、金星、地球、火星、木星、土星、天王星和海王星同时位于航行场景。保留地球的 4K 地表、独立云层、城市夜景与海洋高光；其他天体具有陨石坑、厚云、极冠、木星大红斑、土星环与阴影、冰巨星云带、太阳日冕与日珥。观测模式继续支持图层、自转和相机预设。

这是一版单人自由航行游戏，使用压缩距离和展示尺寸、简化推力与惯性、加速及防撞护盾；未模拟真实引力、轨道力学、地表降落或多人联机。航速和距离为展示单位换算，不代表科学尺度。地球贴图是静态影像，其余天体是程序化艺术材质。

## 验证与结构

浏览器测试使用 Chromium，检查实际渲染像素和驾驶操作，而非仅检查界面出现。无显卡环境使用 SwiftShader；其帧率不代表用户显卡。可用 `PLAYWRIGHT_CHROMIUM_EXECUTABLE` 指定 Chromium，或执行 `npx playwright install chromium`。

云浏览器策略阻止 `file://` 导航；离线验证在普通浏览器来源中载入导出的完整 HTML，再断网测试，不绕过文件策略，也未验证在云浏览器中双击文件的系统行为。

- `src/planet-scene.ts`：共用渲染器、观测与连续航行场景、相机、模型及资源管理。
- `src/planet-models.ts`：天体着色器，支持航行世界中的位置与尺寸。
- `src/ship-dynamics.ts`：推力、六轴运动、惯性、制动与连续碰撞保护。
- `src/flight-controls.ts`、`src/flight-ui.ts`：键盘、鼠标、触屏驾驶与仪表。
- `src/ship-model.ts`：外部飞船模型与引擎尾焰。
- `src/flight-store.ts`：服务端存档与本机回退。
- `shared/`：前后端共用世界配置及航行状态校验。
- `server/`：HTTP 服务、静态游戏页面、持久保存与测试。
- `scripts/`：开发启动、独立导出与离线验证。
- `public/textures/`：地球高清贴图，来源见 [ASSETS.md](ASSETS.md)。
