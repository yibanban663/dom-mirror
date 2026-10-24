# WAF RBI 帧流 PoC（WAF 实验环境）

> 独立实验容器，与机器上现有 DynamicDefend 业务栈（26 容器）**完全隔离**：
> 独立目录 `/opt/rbi-demo`、独立容器 `rbi-demo`、默认 bridge 网络、仅发布 18088 端口、
> 资源上限 `1.5GB 内存 / 1.5 CPU`，会话上限 3。不触碰任何现有容器、网络与配置。

## 目的

验证用 RBI（Remote Browser Isolation）帧流替代已退役的 SW 加密隧道：
客户端只拿到服务端 Chromium 的像素帧，业务源码与数据永不离开服务器。

## 架构

```
访客浏览器                         WAF (10.1.1.32)
┌──────────────┐    WS(JPEG帧/事件JSON)    ┌─────────────────────────────┐
│ 演示壳页面    │◄────────────────────────► │ 容器 rbi-demo :18088→8088   │
│ canvas+指标   │                           │  ├ Node(server.js)          │
└──────────────┘                           │  ├ CDP ──► 无头 Chromium    │
                                           │  └ HTTP ─► 源站 127.0.0.1:8077│
                                           └─────────────────────────────┘
```

- **帧流**：CDP `Page.startScreencast`（仅变化推帧、带回压 ack、30fps 节流）
- **编码演进（运行时可切，实测 1280×800 同一交互场景）**：

| 模式 | 流量 | 输入→数据到达 | 说明 |
|---|---|---|---|
| JPEG q60（基线） | 2050 KB | 27–30 ms | CDP 直发 |
| WebP | 1825 KB (-11%) | 87–92 ms | 同码率省一点，编码更慢 |
| **H.264 x264 ultrafast/zerolatency** | **456 KB (-78%)** | **30–33 ms** | ffmpeg image2pipe，Annex-B over WS，客户端 WebCodecs 解码 |

  H.264 关键参数：`-analyzeduration 0 -probesize 1M`（稀疏输入首帧即出流，否则要攒 150 帧才开始编码）、`keyint=30`、`repeat-headers=1`（WebCodecs 免描述符配置）。码流已离线验证：50.8KB 抓流零错误解码 23 帧，表格区 PSNR 19.2dB（筛选生效）、页头 30.3dB（仅时钟变化）。
  注：客户端 H.264 解码依赖 WebCodecs（Chrome/Edge 均支持）；ZCode 内嵌浏览器面板无 WebCodecs，会提示并需切回 JPEG 模式。

- **输入回传**：CDP `Input.dispatchMouseEvent / dispatchKeyEvent`（鼠标/滚轮/键盘）
- **受保护源站**：仅绑定容器回环 `127.0.0.1:8077`，宿主机不发布——外部物理不可达
- **演示要点**：源站 JS 内置 `API_SIGN_KEY` 等敏感常量，可在客户端 DevTools 全局搜索验证零泄漏

## 操作

```bash
cd /opt/rbi-demo
docker build -t rbi-demo:poc .
docker run -d --name rbi-demo --restart unless-stopped \
  --memory 1536m --memory-swap 1536m --cpus 1.5 \
  -p 18088:8088 rbi-demo:poc
# 访问 http://10.1.1.32:18088/（办公网/VPN 可达）
docker logs -f rbi-demo
```

回滚（完全移除）：

```bash
docker rm -f rbi-demo && docker rmi rbi-demo:poc && rm -rf /opt/rbi-demo
```

## PoC 覆盖与未覆盖

| 项 | 状态 |
|---|---|
| 像素帧流（变化推帧+回压） | ✅ |
| 鼠标/滚轮/键盘回传 | ✅（IME 本地合成框未做，英文/数字可测） |
| 帧质量切换与带宽实时观测 | ✅ |
| 会话隔离与并发上限 | ✅（3 会话，页面级隔离） |
| Chromium 崩溃自动重启 | ✅（按需重拉） |
| 下载/剪贴板/文件上传 | ❌ 生产需实现 |
| IME 中文输入 | ❌ 需本地合成框 |
| vector 指令流（省带宽演进） | ❌ Cloudflare 路线，另立项 |
| 浏览器集群/会话调度 | ❌ 生产需 K8s/池化 |
| 与WAF Proxy/WAF 管理面集成 | ❌ 验收后按 PR 方案做 |
