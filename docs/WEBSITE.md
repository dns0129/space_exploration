# 星际探索网站与自动发布

网站首页介绍太阳系与半人马座 α 目的地、自由驾驶和跃迁，在线游戏为同一个源码构建出的真实 3D 游戏，无需下载 ZIP。网站部署地址为 `https://dns0129.github.io/space_exploration/`，在线游戏路径为 `game.html`。只有 GitHub Pages 配置完成且部署成功后，这些地址才可访问。

## 首次启用

在 [仓库 Settings → Pages](https://github.com/dns0129/space_exploration/settings/pages) 的 **Build and deployment → Source** 选择 **GitHub Actions**。只需设置一次。

如果此前的部署因 Pages 未启用而失败，在 [Actions](https://github.com/dns0129/space_exploration/actions/workflows/deploy-site.yml) 打开 **Deploy 星际探索 website**，选择 **Run workflow**，或重新运行失败的任务。工作流不需要额外的密钥；它使用仓库自带的 `GITHUB_TOKEN` 和 Pages 身份令牌。

仓库需允许 GitHub Actions 与 GitHub Pages。仓库或组织配置的环境保护规则可能使部署等待审批；请以 Actions 的实际结果为准。

## 每次更新

任何提交推送到 `main` 都会触发 `.github/workflows/deploy-site.yml`：安装锁定依赖，执行后端与动力学检查，构建首页和游戏，再部署到 Pages。取消尚未完成的旧部署，优先发布最新一次提交。构建失败时保留之前成功发布的网站。

等 Actions 的部署任务成功后刷新网站，即可使用新代码。通常需要几分钟，提交成功并不代表部署已经完成。网站首页底部显示对应的 Git 提交；`version.json` 提供完整提交与构建时间，用来核对线上代码。

已经打开的页面每分钟、以及回到前台时检查新版本；检测到新的提交会显示“新版本已上线”，点击“刷新体验”加载新版本，避免打断正在驾驶的玩家。没有 Service Worker 或离线缓存，JavaScript 与 CSS 文件名包含内容哈希。主页与游戏的路径均以 `/space_exploration/` 为前缀。

在线网站托管静态文件，航行存档使用当前浏览器本机存储，不托管 Node.js 后端。刷新后进入驾驶舱，点击“恢复存档”继续。旧下载包、本机服务器和 Pages 各自属于不同的浏览器来源，存档不自动共享；删除浏览器数据会删除本机存档。需要服务器持久存档时仍可使用完整下载包。

## 本地开发和验证

```sh
npm run dev -- --port 5173 --strictPort
```

开发时 `site.html` 为网站首页，`index.html` 为游戏入口；主页“立即启航”会直接进入自由航行。这里的本机端口仅用于内部开发，不作为公开游戏链接。

```sh
npm run build:site  # 类型检查及网站构建，输出 dist-site/
npm run test:site   # 构建后，验证部署路径下的桌面与手机浏览器行为
```

`scripts/build-site.mjs` 保持原有 `npm run build` 与独立 HTML 导出的工作方式。网站专用构建将首页输出为 `index.html`、游戏输出为 `game.html`，并让游戏跳过后端 API，直接使用本机存档。`VOYAGER_SITE_BASE` 可设置其他合法的部署路径，默认 `/space_exploration/`；构建版本来自 `GITHUB_SHA`，本地则来自当前 Git 提交。

验证会实际加载完整构建，检查主页和手机导航、目的地选择与进入观测、行星像素、直接驾驶、推力、本机保存和刷新恢复、跨恒星系跃迁及背景切换、大气与地表着陆、起飞及着陆存档恢复、新版本刷新以及项目路径下的资源。要求没有 HTTP 错误、浏览器错误或静态托管中的后端 API 请求。截图保存在忽略的 `test-results/site/` 中。

## 画面素材

首页地球、火星与土星 PNG 是现有游戏渲染器生成的原始截图，未引入额外图库；地表贴图作者与许可继续见 [ASSETS.md](../ASSETS.md)。太阳系保留原有 4K 银河全景，半人马座 α 使用独立制作的蓝紫色 4K 美术全景。太阳、行星和卫星使用实测高清影像；没有全球影像的海王星小卫星、海卫二以及半人马座三颗恒星和比邻星 b/c/d 使用公开许可的 4K 高清概念图，并在 ASSETS.md 中逐一标注。卫星和半人马座天体的贴图在接近或观测时才从 `textures/` 下载。系外行星地表为探索示意，c/d 标注为候选行星。首页没有运行第二个 WebGL 场景，完整 3D 渲染只在进入游戏后启动。
