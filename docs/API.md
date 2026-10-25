# Node.js 集成 API（0.11.0）

唯一公共入口为 `createMirror(options)`，支持 CommonJS，并附带 `index.d.ts`。引入包不会监听端口、启动 Chromium 或注册进程级错误/信号处理。实例不读取 Demo 环境变量；Puppeteer 自身的浏览器查找和安装环境配置仍按其行为生效。

## 创建实例

```js
const { createMirror } = require('@lizhen-xxaq/dom-mirror');
const mirror = createMirror({
  originUrl: 'https://your-site.example/',
  maxSessions: 3,
  sessionGraceMs: 60000,
  presentation: 'embedded',
  redactAttributes: ['data-private'],
});
```

| 参数 | 默认值 | 含义 |
|---|---|---|
| `originUrl` | 必填 | 固定 HTTP(S) 源站，可含路径，禁止 URL 凭据 |
| `width` / `height` | `1280` / `800` | 初始视口整数，范围 320–2560 / 240–1600；连接后按访客上报调整 |
| `maxSessions` | `3` | 正整数；包括断线保留会话，不是已验证容量 |
| `sessionGraceMs` | `60000` | 断线保留毫秒数，整数 0–300000 |
| `defaultMode` | `dom` | `dom` 或 `frame` |
| `presentation` | `embedded` | 隐藏演示壳；`demo` 保留模式切换和统计 |
| `allowedOrigins` | `[]` | 允许 `x-rbi-origin` 选取的源站列表；不是 WS Origin 校验 |
| `obfuscate` | `true` | 有字体池时启用；无池自动降级，不提供保密保证 |
| `redactAttributes` | `[]` | 从镜像元素及 html/body 元数据中剔除指定属性；精确名称、忽略大小写，不接受选择器或通配符 |
| `getSessionIdentity` | 未配置 | 同步读取宿主已验证的身份；绑定 WS 会话及恢复 scope，空值/异常/Promise 拒绝升级为 401 |
| `launchOptions` | `{}` | Puppeteer 启动覆盖项，`args` 替换整个默认参数数组 |
| `logger` | `console` | 实现 `log(...args)` 的对象；宿主负责过滤和脱敏 |

参数错误同步抛出 `TypeError`。创建实例不会启动浏览器；浏览器按有效会话惰性创建，每会话独立实例。不同 mirror 的会话、上限、恢复凭据和字体状态独立。`launchOptions` 中的可变对象由调用者保持稳定，实例运行期间不要修改。

## 数据下发策略

隐藏 input、密码及文件输入的 `value` 属性默认不下发，节点和交互路径保留，源站原值不改写。普通输入值仍为交互需要而同步。不要把这理解为自动排除所有隐藏数据：节点的其他属性、隐藏文本、CSS、资源 URL 和允许资源的响应内容仍可能下发。

`redactAttributes: ['data-private']` 作用于全量快照、增量元素补丁和 html/body 元数据，只改变镜像副本。未指定的 `data-*` 保留，避免破坏依赖属性选择器的样式。配置 `class`、`style`、`src` 等属性可能破坏展示或功能，需要宿主逐站验证；这不是通用 sanitizer 或数据防泄漏策略。

此策略不会擦除源站已经画进 PNG 的文字或像素，也不解析 CSS 和资源正文。源站或宿主仍须避免把不应展示的数据放进这些载体。实际观察与复现见[数据边界验收](acceptance/data-boundary-2026-10-26.md)。

## 接入宿主

```js
const http = require('node:http');
const server = http.createServer(mirror.handleRequest);
server.on('upgrade', mirror.handleUpgrade);
server.listen(8088, '127.0.0.1');
```

- `handleRequest(req, res)`：提供内置客户端、`/m/*` 静态资源代理与字体资源。不调用 `next`；同一宿主的其他路由应在调用之前分流。
- `handleUpgrade(req, socket, head)`：处理 `/ws`，其他路径销毁 socket；有其他 WS 服务时由宿主先按路径分流。
- `close(): Promise<void>`：停止接受此实例的请求/升级，终止连接和保留会话，取消会话定时器并等待浏览器初始化与清理。可重复调用并返回同一 Promise。关闭后 HTTP 处理器返回 503，WS 升级被拒绝。

当前客户端的 URL 是根路径绝对地址。每个实例应使用独立 origin 的根路径；不支持任意子路径、多源站动态资源路由或集群恢复。多个实例可在同一 Node.js 进程中运行，宿主分别路由到对应实例。

宿主必须在调用 HTTP/upgrade 处理器前完成鉴权和 WS Origin 策略。入口需要剥除访客注入的 `x-rbi-origin`，仅由可信宿主设置。配置 `getSessionIdentity` 时，恢复 scope 同时绑定源站、请求 Origin 与宿主身份；不配置时仍为匿名模式，不能把随机 token 当作完整用户授权体系。

## 宿主身份与恢复归属

`getSessionIdentity(req)` 在 WS 升级前同步调用，返回宿主确认的非空身份字符串。返回空值、非字符串、Promise 或抛出异常时返回 HTTP 401，不创建 WS 会话或浏览器。身份只进入实例内部 scope，不下发给客户端；客户端在 hello 中附加 user/tenant 等字段不会改变它。

推荐宿主提供包含租户与用户的稳定键，必要时加上登录会话版本；同名用户跨租户不能共用键。下面的 `authenticate` 必须由宿主实现并验证凭据，不能直接信任访客提供的用户名头、query 或 hello 字段。此片段替换前面的 upgrade 接线，不要同时注册两个处理器；HTTP 请求仍需单独鉴权：

```js
const authenticated = new WeakMap();
const mirror = createMirror({
  originUrl: 'https://your-site.example/',
  getSessionIdentity: req => authenticated.get(req),
});

server.on('upgrade', (req, socket, head) => {
  if (req.headers.origin !== 'https://your-public-host.example') {
    socket.destroy();
    return;
  }
  authenticate(req).then(user => {
    if (!user || socket.destroyed) { socket.destroy(); return; }
    authenticated.set(req, JSON.stringify([user.tenantId, user.id]));
    mirror.handleUpgrade(req, socket, head);
  }).catch(() => socket.destroy());
});
```

异步鉴权由宿主先完成；包的身份回调保持同步。该回调只处理 WS 入场及恢复归属，**不保护 HTTP 资源、不实现登录、不持续重验已建立连接，也不自动撤销活跃 WS**。注销、禁用账号或变更权限后，宿主还需主动关闭受影响的连接。源站业务权限也仍由源站校验。实际前后对照见[身份边界验收](acceptance/session-identity-2026-10-26.md)。

## 关闭与故障

包不处理 SIGTERM/SIGINT，不调用 `process.exit()`，不安装 `unhandledRejection` 监听器。宿主负责停止新请求、等待 `mirror.close()`，然后关闭宿主 HTTP 连接。完整写法见 [最小宿主](../examples/host.cjs)。

关闭会等待 Puppeteer 正在进行的启动操作结束，再回收晚到的浏览器；`launchOptions.timeout` 应使用有限值。会话只在实例内存中保留，进程或 Chromium 退出不提供持久恢复，也不重放业务提交。

鉴权、TLS、入口限流、用户配额、审计与部署策略归宿主；镜像协议和资源生命周期归包。当前默认 Chromium 参数仍含 `--no-sandbox`，Demo 镜像仍以 root 运行，HTML 清理和网络访问策略也未完成通用安全验收。此次抽取接口不代表完成生产加固，详见 [安全边界](../README.zh-CN.md#安全边界)。

## 从旧入口迁移

- `require('@lizhen-xxaq/dom-mirror')` 返回 `{ createMirror }`，不再启动独立服务。
- `node server.js` 不再启动；体验 Demo 改用 `npm run demo` 或 `node demo/server.js`。`npm start` 和默认 Docker 启动仍运行 Demo。
- `ORIGIN_URL`、`MAX_SESSIONS` 等环境变量由 Demo 转为工厂参数，依赖包调用者直接传参数。
- Demo 默认保留演示控件；依赖包默认 `embedded`。WS 消息格式与 0.10.1 相同，没有新增传输通道。
- 推荐按固定源站创建实例；用户系统、持续授权和活跃连接撤销归宿主，事件/错误契约及更多真实宿主验收仍待完善。
