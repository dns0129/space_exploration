# 网页与桌面客户端共用的游戏架构

网页、静态网站、独立 HTML 与 Electron 桌面客户端共用飞行核心和 Three.js 渲染。桌面端已经实现独立窗口、本地资源协议和文件存档；安装包流程见 [桌面客户端说明](DESKTOP.md)。当前没有桌面自动更新、跨平台存档同步、开发者签名或 Apple 公证。

## 现有分层

| 层 | 文件 | 职责 |
| --- | --- | --- |
| 飞行核心 | `src/ship-dynamics.ts`、`src/core/flight-input.ts`、`shared/` | 世界配置、飞行、碰撞、跃迁、着陆、输入命令与存档校验；无需 DOM |
| 存档策略 | `src/flight-store.ts` | 校验、服务端与本机回退、按顺序保存；不访问浏览器或发 HTTP 请求 |
| 平台接口 | `src/platform/flight-services.ts`、`src/platform/assets.ts` | 异步存档、可选后端与纹理资源解析契约 |
| 网页适配 | `src/platform/browser.ts`、`browser-storage.ts`、`http-flight-backend.ts`、`src/flight-controls.ts` | 浏览器存储、连接状态、HTTP、键盘与触屏事件 |
| 桌面适配 | `src/platform/desktop.ts`、`runtime.ts`、`desktop/preload.cjs` | 构建时选择平台、窄范围 IPC 存档与退出通知 |
| 桌面宿主 | `desktop/main.mjs`、`local-protocol.mjs`、`save-repository.mjs` | 原生窗口与菜单、本地资源协议、存档文件、退出等待 |
| 渲染与界面 | `src/planet-scene.ts`、`src/flight-ui.ts`、`src/main.ts` | Three.js 场景、仪表与入口装配 |

Three.js 在飞行核心中用于向量、矩阵和四元数运算；Node 测试可以直接执行这些计算，不需要创建浏览器或 WebGL 上下文。桌面端复用网页渲染和界面，窗口中的浏览器环境由 Electron 提供。

## 存档接口

入口 `main.ts` 创建 `FlightStore(createRuntimeFlightServices())` 并注入 `FlightInterface`，界面不再自行创建平台依赖。`runtime.ts` 根据构建常量 `VITE_DESKTOP` 选择浏览器或桌面适配；桌面构建缺少合法 preload 桥接时明确报错，避免把客户端错误保存到浏览器存储。

`FlightSaveRepository` 的 `read()` 返回未知数据，`write(state)` 异步写入已校验的快照。核心统一负责旧格式迁移和校验，浏览器和桌面适配使用同一规则。`FlightBackend` 单独负责远程世界、读取和写入；HTTP 适配器可配置 API 基础地址，默认仍是同源 `/api`。桌面适配只提供本机存档，不配置 HTTP 后端。

桌面适配使用以下装配方式：

```ts
const store = new FlightStore({
  saves: {
    read: () => bridge.readSave(),
    write: state => bridge.writeSave(state),
  },
});
```

`bridge` 由 `desktop/preload.cjs` 暴露。主进程只接受当前游戏主文档的 IPC，渲染层不能指定文件路径。`DesktopSaveRepository` 在 `userData/flight.json` 保存最多 8 KiB 的已校验快照，通过临时文件、同步写入和原子替换完成；拒绝符号链接存档。窗口退出前要求渲染器保存最新快照，并等待主进程写入完成，失败时显示处理提示。`server/flight-store.test.mjs` 与 `desktop/save-repository.test.mjs` 使用真实临时文件验证保存策略与宿主仓库。

保存会先写本机备份，再尝试已连接的服务端。整个保存操作按调用顺序串行执行，防止较早的自动存档晚于退出存档完成而覆盖新进度。单次失败不会阻塞后续保存。收到保存请求时立即校验并复制快照，排队期间的飞行变化不修改待保存内容。

浏览器继续使用 `voyager-flight-v1` 键和原有存档格式。公开 Pages 与独立文件不配置后端；离线、后端不兼容或请求失败时继续使用本机存档。不同浏览器来源和客户端的存档各自独立，没有跨平台存档迁移功能。

## 资源接口

`AssetResolver.texture(file)` 统一解析地球、天空、常驻、延迟加载和紧凑版本纹理。网页遵循构建的部署基础路径；桌面构建使用 `/` 基础路径，按当前 `voyager://game` 来源加载打包的资源。

```ts
const assets = createAssetResolver("/");
// SolarScene(container, onStats, onError, assets)
```

独立 HTML 导出向稳定的 `asset-manifest.ts` 模块提供完整 data URL 清单，不再查找和替换渲染源码字符串。显式清单缺少资源时立即报错，不回退到网络。原贴图分辨率、显存预算、延迟加载和画质策略保持原有实现。

桌面协议只读取 `dist-desktop/` 内部的资源，限制 URL 来源、路径、实际文件位置与请求方法，并附加 CSP；既不启动 HTTP 服务，也不读取任意本机文件。窗口启用沙箱和上下文隔离、禁用 Node 集成，资源网络请求与权限请求由主进程限制。

## 输入接口

`FlightInputState` 将来源独立的动作转换为六轴输入，保留原有键位、方向符号、转向限幅与死区。键盘和触屏同时按住同一动作时，释放其中一个来源不会清除另一个来源。

`InputSource` 提供 `read()`、`aim`、`clear()`、`dispose()`。网页与桌面端共用 `FlightControls` 的键盘和触屏适配；`SolarScene` 的第 5 个参数可注入输入工厂，因此未来手柄输入不需要改写飞行动力学：

```ts
new SolarScene(container, onStats, onError, assets, createGamepadInput);
```

## 验证与后续工作

网页与独立包按仓库已有流程运行 `npm run build`、`npm run test:server`、`npm run test:site`、`npm run test:offline`。输入相关浏览器用例见 `tests/flight.spec.ts` 与 `tests/flight-refinement.spec.ts`。

桌面端运行 `npm run test:desktop:unit` 验证本地协议、IPC 输入和真实文件存档，再运行 `npm run test:desktop` 启动真正的 Electron，验证渲染像素、驾驶、存档、退出等待、重启恢复、隔离与零 HTTP 请求。打包应用可通过 `VOYAGER_DESKTOP_EXECUTABLE` 指定实际可执行文件运行同一验证；命令见 [桌面客户端说明](DESKTOP.md)。

后续工作包括在目标系统实际安装验证、正式开发者签名与公证、自动更新和可选的跨平台存档迁移。这里的接口让平台相关工作集中在适配层；若未来改用其他游戏引擎，渲染与界面仍需迁移。
