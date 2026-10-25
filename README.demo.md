# 内置演示

本项目附带一个仅绑定回环的演示源站，供验证 DOM 镜像、输入回传及 PNG 差分通道。部署和配置以 [README](README.md) 为准。

```bash
docker build -t dom-mirror:local .
docker run --rm --name dom-mirror-demo \
  --memory 1536m --cpus 1.5 \
  -p 127.0.0.1:18088:8088 dom-mirror:local
```

访问 `http://127.0.0.1:18088/`：

1. 在默认 DOM 模式测试搜索、表单输入、按钮和滚动。
2. 切换 frame 模式，比较画面与交互。
3. 在 DevTools 查看 WS JSON 消息与 Shadow DOM。DOM/CSS 及部分数据会下发，frame 也保留镜像 DOM。
4. 关闭连接后检查会话释放，再重新连接。默认最多 3 会话。

内存/CPU 参数是示例限制，不是容量保证。未配置混淆字体池时，中文以原文下发；混淆开启也不等于保密。内置页面里的演示常量不得替换为真实密钥。

本演示不自动接入 WAF，不依赖特定内网主机，也不会修改现有业务部署。远程开放入口前需配置认证和访问限制。
