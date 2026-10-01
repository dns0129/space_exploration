# 自由驾驶飞船

下载 **`voyager-flight.zip`**，完整解压，将 `voyager-flight.html` 拖入 Chrome 或 Edge。点击顶部“自由航行”，按 W 出发，拖动或方向键转向，Shift 加速，空格刹车，C 切换视角。手机使用触屏驾驶按钮。

独立 HTML 包含全部程序、样式与高清素材，可离线驾驶，使用本机存档。选择导航目标后可对准航向或跃迁到附近，支持暂停、保存和恢复。

包内也有后端程序。安装 Node.js 24 LTS 后双击 `启动航行.bat`（Windows），或运行 `bash 启动航行.sh`（macOS/Linux），然后在本机浏览器打开 `http://127.0.0.1:3000/`。也可直接运行 `node server/server.mjs --standalone`。后端不需要安装 npm 依赖，存档保存在 `data/` 中。

浏览器需要支持 WebGL 2 并启用图形加速，性能不足时可选择标准画质。完整说明见 ZIP 中的中文打开说明和仓库 README。

`voyager-solar-system.zip`、`voyager-earth.zip` 是阶段 02、阶段 01 存档，不包含驾驶功能。
