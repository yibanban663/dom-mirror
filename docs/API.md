# Node.js 集成 API（0.27.0）

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
| `crossOriginFrameOrigins` | `[]` | 允许 Node 侧抓取的跨源 iframe 源列表；默认仅占位，不允许 URL 凭据；独立于 `allowedOrigins` |
| `requestOrigins` | `[]` | 服务端浏览器额外可访问的源（CDN、接口域名）。会话源站、`crossOriginFrameOrigins` 与此列表之外的请求一律拦截，含导航、表单提交与弹窗；主框架导航被拦截时向客户端发送 `NAVIGATION_BLOCKED` |
| `canvasStream` | `true` | 可序列化 2D canvas 指令流，其他画布回退位图 |
| `chromiumSandbox` | `true` | 保留 Chromium sandbox；宿主须以非 root 运行并提供 user namespace（容器见 `docker/seccomp-chromium.json`）。`false` 仅用于无法满足的环境，渲染进程被攻破即获得宿主进程权限 |
| `maskInputTypes` | `[]` | 指定输入类型的下发值改为最多 32 个星号；textarea 使用 `textarea`，不处理像素或上行数据 |
| `upload` | 见下文 | 文件扩展名、单文件/会话总量、并发与过期限制 |
| `download.maxBytes` | `33554432` | 下载单文件上限；进度超限请求取消，完整读入内存前复核大小 |
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

## 文件与跨源 iframe 边界

上传默认单文件 8MiB、整个会话累计 16MiB、最多两个待传文件、30 秒无分块进展即过期，每个会话最多接受 64 个待传/已完成文件。会话累计预算可用 `upload.maxTotalBytes` 调整，已完成或已尝试落盘的文件占用预算直到会话结束；失败/过期的未完成传输释放预留量。恢复同一会话不会重置预算。其余选项为 `upload.maxBytes`、`upload.maxConcurrent`、`upload.idleTimeoutMs` 和 `upload.extensions`。这些限制不代替源站病毒扫描和业务配额。

`crossOriginFrameOrigins: ['https://embed.example/']` 显式允许该源的 Node 侧嵌入 HTML 抓取及本会话资源代理；默认空列表只显示占位块。页面中出现 URL 不构成宿主授权；该选项也不是 Chromium 的出站过滤器。抓取不转发源站会话凭据、不跟随重定向；Node 与 Chromium 都需要宿主限制网络访问。跨源 srcdoc 使用与主文档相同的输入值和指定属性过滤，CSS、可见文本、资源正文及像素仍不提供自动敏感识别。

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

异步鉴权由宿主先完成；包的身份回调保持同步。该回调只处理 WS 入场及恢复归属，**不保护 HTTP 资源、不实现登录、不持续重验已建立连接，也不自动撤销活跃 WS**。宿主需要在注销、禁用账号或变更权限时调用下面的撤销接口。源站业务权限也仍由源站校验。身份绑定的历史前后对照见[身份边界验收](acceptance/session-identity-2026-10-26.md)。

## 宿主主动撤销

- `revokeSession(token): Promise<boolean>`：以恢复 token 精确选择一个在线或断线保留会话，存在返回 `true`，不存在或已撤销返回 `false`。匿名模式也可使用；token 属于敏感凭据，宿主若保存它应避免进入日志或公开接口。
- `revokeIdentity(identity): Promise<number>`：按 `getSessionIdentity` 返回的完整字符串精确匹配，撤销本实例该身份的全部在线和断线保留会话，并关闭已进入本实例、尚未发送 hello 的同身份 WS。返回选中的逻辑会话数；未完成握手的连接不计数。未配置身份回调时返回 `0`。

两种方法都在调用时立即作废选中会话的恢复 token、阻止后续指令派发，并以 WS 关闭码 `4001` / `SESSION_REVOKED` 通知连接，再等待传输关闭、相关初始化及页面/浏览器清理。对端不响应关闭握手时，最多等待 1 秒便强制终止；页面和浏览器清理独立进行。空字符串、纯空白或非字符串参数使 Promise 以 `TypeError` 拒绝。选择范围仅限当前 mirror 实例，不跨进程广播；重复调用已撤销的目标返回 `false` / `0`。实例关闭后也返回 `false` / `0`。

配套客户端收到 4001 后明确显示已撤销、清空恢复 token、禁用交互并停止重连；宿主负责重新登录或导航。若链路异常而未收到关闭码，页面无法可靠区分断网和注销，服务器端凭据拒绝及 token 作废仍生效，详见[协议](PROTOCOL.md)。

宿主注销处理示意（`revokeHostCredentials` 由宿主实现）：

```js
// This key must exactly match getSessionIdentity(req).
const identity = JSON.stringify([user.tenantId, user.id]);
await revokeHostCredentials(user); // Reject old credentials on HTTP and WS first.
const endedSessions = await mirror.revokeIdentity(identity);
```

撤销不是永久封禁：若宿主继续接受同一个身份的新连接，它仍可创建新会话。宿主尚未完成的异步鉴权也在包的控制范围之外，需要在调用 `handleUpgrade` 前重新检查凭据状态。若希望只注销一次登录，身份键应包含登录会话 ID 或版本；仅用租户/用户键会撤销该用户在本实例的所有登录会话。权限变更时同样应先更新宿主策略，再撤销相关会话。

已派发给源站的请求或已提交的业务操作不能撤回；撤销不会回滚数据或清除已展示给客户端的信息，也不注销源站自身的登录凭据。仍需宿主和源站共同处理。初始化/清理等待依赖 Puppeteer 完成，宿主应配置有限的启动超时。

Node 回归使用真实本地 HTTP/WS 与替身浏览器，覆盖在线/断线会话、握手窗口、身份及实例隔离、恢复拒绝、晚启动和异步资源清理。另已完成合成宿主 DOM/frame 的[真实 Chromium 注销验收](acceptance/session-revocation-2026-10-26.md)，同时检查源站提交、旧 token 拒绝与页面/子进程回收；未验证跨实例广播或真实账号提供方。

## 关闭与故障

包不处理 SIGTERM/SIGINT，不调用 `process.exit()`，不安装 `unhandledRejection` 监听器。宿主负责停止新请求、等待 `mirror.close()`，然后关闭宿主 HTTP 连接。完整写法见 [最小宿主](../examples/host.cjs)。

关闭会等待 Puppeteer 正在进行的启动操作结束，再回收晚到的浏览器；`launchOptions.timeout` 应使用有限值。会话只在实例内存中保留，进程或 Chromium 退出不提供持久恢复，也不重放业务提交。

鉴权、TLS、入口限流、用户配额、审计与部署策略归宿主；镜像协议和资源生命周期归包。当前默认 Chromium 参数仍含 `--no-sandbox`，Demo 镜像仍以 root 运行，HTML 清理和网络访问策略也未完成通用安全验收。此次抽取接口不代表完成生产加固，详见 [安全边界](../README.zh-CN.md#安全边界)。

## 从旧入口迁移

- `require('@lizhen-xxaq/dom-mirror')` 返回 `{ createMirror }`，不再启动独立服务。
- `node server.js` 不再启动；体验 Demo 改用 `npm run demo` 或 `node demo/server.js`。`npm start` 和默认 Docker 启动仍运行 Demo。
- `ORIGIN_URL`、`MAX_SESSIONS` 等环境变量由 Demo 转为工厂参数，依赖包调用者直接传参数。
- Demo 默认保留演示控件；依赖包默认 `embedded`。WS 消息格式与 0.10.1 相同，没有新增传输通道。
- 推荐按固定源站创建实例；用户系统与持续授权归宿主，宿主通过撤销接口控制现有会话；事件/错误契约及更多真实宿主验收仍待完善。
