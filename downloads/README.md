# 写实太阳系与跃迁引擎

下载 **`voyager-warp.zip`**，完整解压，将 `voyager-warp.html` 拖入 Chrome 或 Edge。点击顶部“自由航行”，按 W 出发，方向键转向（鼠标不操控飞船），Shift 加速，空格刹车，C 切换视角，J 启动跃迁引擎。手机使用触屏驾驶按钮。

卫星导航包括月球及四颗巨行星的 25 颗主要卫星，共 35 个天体。距表面 1000 km 内通常最高 100 km/s；100 km 内朝太空可用行星引擎离开，近地仍禁止跃迁。制动时有琥珀色减速脉冲。

独立 HTML 包含全部程序、样式与高清素材，可离线驾驶，使用本机存档。使用 4K 银河背景与真实太阳系尺寸、平均日距。选择导航目标后可对准航向，或启动跃迁，经蓄能、航道和减速抵达附近，支持暂停、保存和恢复。

包内也有后端程序。安装 Node.js 24 LTS 后双击 `启动航行.bat`（Windows），或运行 `bash 启动航行.sh`（macOS/Linux），然后在本机浏览器打开 `http://127.0.0.1:3000/`。也可直接运行 `node server/server.mjs --standalone`。后端不需要安装 npm 依赖，存档保存在 `data/` 中。

浏览器需要支持 WebGL 2 并启用图形加速，性能不足时可选择标准画质。完整说明见 ZIP 中的中文打开说明和仓库 README。

`voyager-flight.zip` 为阶段 03 自由航行包，`voyager-solar-system.zip` 与 `voyager-earth.zip` 为前两阶段观测存档。新版写实空间与跃迁引擎在 `voyager-warp.zip`。
