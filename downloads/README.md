# 在浏览器中体验太阳系

下载同目录下的 **`voyager-solar-system.zip`**，完整解压，然后把 `voyager-solar-system.html` 拖进 Chrome 或 Edge。

ZIP 内包含一个独立 HTML 游戏和中文打开说明。程序、样式、图标以及地球的五张 4K 贴图已嵌入 HTML，太阳和其余行星使用程序化材质，无需安装 Node.js、启动服务器或联网。浏览器需要支持 WebGL 2 并启用图形加速。

阶段 02 可切换太阳和八颗行星，拖动环绕、滚轮缩放，使用全景与近观预设。地球支持夜景；其他行星可观察背光面。图层根据当前天体显示，金星可切换云层，土星可切换环系，太阳可切换日冕。

独立 HTML 已在断网 Chromium 上下文中验证全部九个天体的实际渲染和返回地球，未发起 HTTP 请求。云端测试浏览器的管理策略禁止 `file://` 导航，测试通过离线载入完整 HTML 内容完成。

`voyager-earth.zip` 是阶段 01 的地球版存档，不包含新增天体。

素材来源见根目录的 `ASSETS.md` 和 `THIRD_PARTY_NOTICES.md`。更新源码后可用 `npm run export` 重新生成太阳系 HTML 与 ZIP。
