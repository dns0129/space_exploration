# 网页与未来客户端共用的游戏架构

本次拆分为独立桌面客户端预留平台接口。当前交付仍为网页、静态网站和独立 HTML；没有加入 Electron/Tauri 安装包、桌面自动更新或原生文件服务。

## 现有分层

| 层 | 文件 | 职责 |
| --- | --- | --- |
| 飞行核心 | `src/ship-dynamics.ts`、`src/core/flight-input.ts`、`shared/` | 世界配置、飞行、碰撞、跃迁、着陆、输入命令与存档校验；无需 DOM |
| 存档策略 | `src/flight-store.ts` | 校验、服务端与本机回退、按顺序保存；不访问浏览器或发 HTTP 请求 |
| 平台接口 | `src/platform/flight-services.ts`、`src/platform/assets.ts` | 异步存档、可选后端与纹理资源解析契约 |
| 网页适配 | `src/platform/browser.ts`、`browser-storage.ts`、`http-flight-backend.ts`、`src/flight-controls.ts` | 浏览器存储、连接状态、HTTP、键盘与触屏事件 |
| 渲染与界面 | `src/planet-scene.ts`、`src/flight-ui.ts`、`src/main.ts` | Three.js 场景、仪表与入口装配 |

Three.js 在飞行核心中用于向量、矩阵和四元数运算；Node 测试可以直接执行这些计算，不需要创建浏览器或 WebGL 上下文。渲染和界面仍使用网页技术，适合未来复用到网页技术桌面容器中。

## 存档接口

入口 `main.ts` 创建 `FlightStore(createBrowserFlightServices())` 并注入 `FlightInterface`，界面不再自行创建平台依赖。

`FlightSaveRepository` 的 `read()` 返回未知数据，`write(state)` 异步写入已校验的快照。核心统一负责旧格式迁移和校验，因此未来文件或 IPC 适配器也使用同一规则。`FlightBackend` 单独负责远程世界、读取和写入；HTTP 适配器可配置 API 基础地址，默认仍是同源 `/api`。

未来桌面入口可使用以下装配方式：

```ts
const store = new FlightStore({
  saves: desktopSaves,
  // 有服务器存档需求时再提供 backend 和 isOnline。
});
```

`desktopSaves` 由客户端通过受控的宿主桥接实现本地文件读写；网页渲染层不直接取得任意文件系统权限。`server/flight-store.test.mjs` 使用真实临时文件验证同一存档策略可以在无浏览器环境保存和恢复。

保存会先写本机备份，再尝试已连接的服务端。整个保存操作按调用顺序串行执行，防止较早的自动存档晚于退出存档完成而覆盖新进度。单次失败不会阻塞后续保存。收到保存请求时立即校验并复制快照，排队期间的飞行变化不修改待保存内容。

浏览器继续使用 `voyager-flight-v1` 键和原有存档格式。公开 Pages 与独立文件不配置后端；离线、后端不兼容或请求失败时继续使用本机存档。不同浏览器来源和未来客户端的存档仍各自独立，本次没有新增跨平台存档迁移功能。

## 资源接口

`AssetResolver.texture(file)` 统一解析地球、天空、常驻、延迟加载和紧凑版本纹理。网页遵循构建的部署基础路径；客户端可以提供本地协议路径或完整素材清单。

```ts
const assets = createAssetResolver("asset://voyager/");
// SolarScene(container, onStats, onError, assets)
```

独立 HTML 导出向稳定的 `asset-manifest.ts` 模块提供完整 data URL 清单，不再查找和替换渲染源码字符串。显式清单缺少资源时立即报错，不回退到网络。原贴图分辨率、显存预算、延迟加载和画质策略保持原有实现。

## 输入接口

`FlightInputState` 将来源独立的动作转换为六轴输入，保留原有键位、方向符号、转向限幅与死区。键盘和触屏同时按住同一动作时，释放其中一个来源不会清除另一个来源。

`InputSource` 提供 `read()`、`aim`、`clear()`、`dispose()`。`FlightControls` 实现当前网页适配；`SolarScene` 的第 5 个参数可注入输入工厂，因此未来手柄或客户端输入不需要改写飞行动力学：

```ts
new SolarScene(container, onStats, onError, assets, createDesktopInput);
```

## 验证与后续客户端工作

按仓库已有流程运行 `npm run build`、`npm run test:server`、`npm run test:site`、`npm run test:offline`。输入相关浏览器用例见 `tests/flight.spec.ts` 与 `tests/flight-refinement.spec.ts`。

实际制作客户端时还需选择桌面容器、实现宿主存档桥接、注册本地资源协议，以及制作各平台安装、签名和更新流程。这里的接口让这些工作集中在平台层；它们尚未实现。若未来改用其他游戏引擎，渲染与界面仍需迁移。
