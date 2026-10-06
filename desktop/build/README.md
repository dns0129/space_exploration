# 客户端图标

`icon.png`、`icon.icns`、`icon.ico` 都来自已有的 `public/favicon.svg`，没有新增图库或 AI 图像。PNG 为 1024 × 1024，ICNS 包含标准及 Retina 尺寸，ICO 包含 16–256 像素尺寸。

在 macOS 的仓库根目录执行以下命令，可用系统的 SVG 渲染和 `iconutil` 重新生成这三个文件：

```sh
swift desktop/build/prepare-icons.swift
```

打包和 CI 使用已经提交的图标，不需要额外图像处理依赖。
