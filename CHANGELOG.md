# Changelog

本文件记录 dom-mirror 的版本演进。协议破坏性变更见 docs/PROTOCOL.md。

## Unreleased

### Fixed
- skiadom：下拉框（select）在镜像中显示为空——option 文本被占位/清空导致原生控件标签消失。
  现在 SELECT 子树不参与 runs 收集，克隆时仅保留选中项标签（其余 option 文本不下发）。
- 三个 runs 收集器跳过 SCRIPT/STYLE 等标签时未计数，导致后续兄弟节点路径错位
  （dombitmap 下可能造成个别文本替换静默失败）。

## v0.1.0（2026-10-22）

首个发布版本：RBI 引擎 + 五通道演示，Apache-2.0。

### 通道
- `jpeg` / `webp`：CDP screencast 直发（30fps 节流、仅变化推帧、q10-95 运行时可切）
- `h264`：screencast → ffmpeg(x264 ultrafast/zerolatency) → Annex-B over WS → WebCodecs 解码
  （关键参数 `-analyzeduration 0 -probesize 1M`：稀疏输入首帧即出流）
- `dom`：DOM 镜像——海关序列化（剥 script/事件属性、URL 重写、canvas→位图）、元素级补丁、
  路径回传事件、字体一致性（服务端 fontconfig TTC 下发，FontFace API 按字重注册）
- `dombitmap`：DOM+文字位图——文本替换为服务端渲染裁切（inline 放置 + 实测 relative 归位，
  布局零扰动），不可见文本剥除；镜像零明文

### 实测（1280×800，内网）
- 交互延迟：dom/dombitmap 4–8ms；jpeg 27–30ms；h264 30–33ms
- 交互流量：dombitmap 位图补丁 KB 级；dom ~1.4KB/次；h264 456KB；jpeg 2050KB（同场景）
- 一致性：dombitmap 服务端自渲染 vs 无损真基准 avg 3.16/255，文本区 0.0

### 工程设施
- WS 协议 v0.1 文档化（docs/PROTOCOL.md），依赖包化契约
- GitHub Actions CI：语法/结构/协议检查 + Docker 构建 + 冒烟探活
- Docker 一键运行，内置演示源站；支持 `ORIGIN_URL` 指向任意真实站点

### 已知边界
见 README"已知边界"清单（表格行 1-2px 偏移、虚拟滚动页面建议像素通道、IME/深链接待做等）。

### 路线
- v0.2：npm 依赖包形态 + Go（chromedp）实现
- v0.3：浏览器池/会话管理与产品化接入
