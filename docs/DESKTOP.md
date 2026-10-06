# 星际探索桌面客户端

桌面版使用 Electron 运行同一套 Three.js 游戏，包含独立窗口、本地游戏资源和文件存档。启动后直接进入自由航行。没有运行本机 HTTP 服务器，也不依赖公开网站来加载游戏。

## 开发与构建

需要 Node.js 24 LTS。先在仓库根目录安装锁定依赖：

```sh
npm ci
npm run desktop
```

`desktop` 先构建 `dist-desktop/`，再启动 Electron。它是本地客户端开发入口；网页版仍使用 `npm run dev`。

```sh
npm run test:desktop:unit
npm run build:desktop
npm run test:desktop
npm run package:desktop -- --mac --arm64
```

安装包输出到 `release-desktop/`，命名为 `Voyager-版本-系统-架构.扩展名`。Apple 芯片使用 `arm64`，Intel Mac 使用 `x64`。macOS 配置生成 DMG 和 ZIP，Windows 生成 x64 NSIS 安装程序，Linux 配置为 x64 AppImage。Windows 和 Linux 配置不等于已在这些系统上验证；以各平台的实际构建与运行结果为准。

```sh
npm run package:desktop -- --mac --x64
npm run package:desktop -- --win --x64
npm run package:desktop -- --linux --x64
```

安装包需要相应系统的打包工具。建议在目标系统打包；Windows 和 macOS 构建也可使用下面的手动 CI。

## 本地存档与窗口

航行状态由主进程保存在 Electron `userData` 目录中的 `flight.json`。在应用菜单中选择打开存档目录，可查看实际位置；菜单还提供全屏与退出。渲染页面通过窄范围的 preload 桥接读取和保存已校验的航行状态，没有任意文件读写权限。退出时先保存最新航行并等待文件写入完成；写入失败或长时间未完成时，窗口提示玩家处理，不将失败的保存当作成功退出。

Mac 默认存档为 `~/Library/Application Support/星际探索/flight.json`。需要独立或便携运行时，可在应用可执行文件后传入 `--voyager-user-data=绝对路径`；该目录必须是单一、非空的绝对路径。不同目录各自保留存档。

网页版、独立 HTML 与客户端存档各自独立。当前没有跨平台自动同步、导入导出或客户端自动更新。重新安装应用并不等于删除 `userData`；手动删除该存档文件会移除客户端的航行进度。

## 资源与安全边界

游戏加载自 `voyager://game/index.html?mode=flight`。主进程注册本地资源协议，读取 `dist-desktop/` 中的代码和贴图，并向响应附加 Content Security Policy。页面保持沙箱、上下文隔离及禁用 Node 集成；客户端并未将文件系统交给渲染器。

客户端构建设置 `VITE_DESKTOP=true` 与 `VITE_PUBLIC_SITE=false`，选择文件存档适配。`npm run build`、公开 Pages 构建及独立 HTML 导出继续使用各自的入口和存档方式。全部高清贴图沿用游戏现有资源；无需在首次运行时另行下载。客户端图标沿用 `public/favicon.svg`，来源和生成方法见 `desktop/build/README.md`。

## 手动构建 CI 模板

`docs/build-desktop.workflow.yml` 是可启用的 Actions 模板，仅提供 `workflow_dispatch`。当前 GitHub 授权缺少 `workflow` 范围，未将它安装到 `.github/workflows/`，因此仓库中没有已启用的桌面构建工作流。具备工作流写入权限后，将模板复制为 `.github/workflows/build-desktop.yml` 并提交，即可手动构建 Apple 芯片 Mac、Intel Mac 与 Windows x64，通过 Actions artifacts 保存安装包 14 天。它不会在提交时自动执行，也不会创建 GitHub Release 或上传到公开网站。

工作流先执行桌面单元测试，再构建和打包，使用 `--publish never`。当前配置关闭自动发现签名证书，macOS `identity` 为 `null`，没有开发者签名或 Apple 公证。这些属于本地测试包，不应描述为已签名或已公证的正式发行版。面向公众分发前，需另行配置合法开发者签名、公证及各目标系统的安装验证。

## 真实客户端验证

`npm run test:desktop` 会启动真正的 Electron 窗口，检查星球和飞船像素、键盘推力、视角切换、本机文件存档、退出前最新进度保存，以及重启后的恢复。同时检查渲染器没有 Node 权限、游戏没有 HTTP 请求。测试用 `--voyager-user-data=绝对路径` 将存档隔离到临时目录，结束后删除测试目录，保留玩家存档。

已打包的应用可以指定实际可执行文件运行同一验证。例如 Apple 芯片 Mac 的未压缩应用：

```sh
VOYAGER_DESKTOP_EXECUTABLE="/absolute/path/release-desktop/mac-arm64/Voyager.app/Contents/MacOS/Voyager" node scripts/verify-desktop.mjs
```

路径需替换为本机实际输出。单元测试、源码运行、应用目录运行和安装包安装属于不同验证阶段；只有实际完成的阶段才可在交付记录中宣称通过。
