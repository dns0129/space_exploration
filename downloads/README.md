# 直接在浏览器中体验地球

下载同目录下的 `voyager-earth.zip`，完整解压，然后把 `voyager-earth.html` 拖进 Chrome 或 Edge。

ZIP 内包含一个独立 HTML 游戏和中文打开说明。程序、样式、图标以及五张 4K 贴图已嵌入 HTML，无需安装 Node.js、启动服务器或联网。

可以拖动环绕、滚轮缩放，使用全景 / 近地 / 夜景切换以及云层、大气、星空和自转控制。当前阶段仅实现地球观测。

独立 HTML 内容已经通过断网 Chromium 的实际渲染及操作检查；云端测试浏览器的管理策略禁止 `file://` 导航，测试使用离线加载同一份 HTML 内容完成。

素材来源见根目录的 `ASSETS.md` 和 `THIRD_PARTY_NOTICES.md`。
