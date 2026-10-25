# Visual assets / 视觉资源

The Logo and conceptual illustration were generated for this project with the built-in image generation tool. Original PNGs are stored here unchanged; the Logo has a transparent background. The illustration is a visual metaphor, not a screenshot or exact protocol diagram. The README Mermaid diagram documents the actual data flow separately.

Logo 和概念配图由内置 imagegen 工具生成，原始 PNG 保存在本目录；Logo 保留透明背景。概念配图不是真实界面或协议图，准确链路另由 README 中的 Mermaid 图说明。

## Files

| Asset | Role |
| --- | --- |
| `logo.png` | Original transparent mark: paired browser panes forming an M |
| `mirroring-illustration.png` | Conceptual illustration of DOM structure, patches and the mirrored view |
| `demo-dom.png` | Actual built-in Demo, initial DOM mode |
| `demo-interaction.png` | Actual Demo after searching `138` and changing monthly rent to `299` |
| `demo-frame.png` | Actual Demo after switching the same session to frame mode |
| `demo-capture.json` | Machine-readable capture provenance and assertions |

Screenshots are captured with Chromium by `tools/capture-demo.cjs`. They are not generated or retouched, and contain only the repository's synthetic data. The script records version, time, viewport and assertions. Overview captures include the horizontally overflowing sidebar, clipped at 960px height; the interaction image captures only the mirror pane. Clock, animation and live counters vary by run. See the [Demo guide](../../README.demo.md) for reproduction and runtime details.

截图由 Chromium 真实采集，不是生成或修饰的界面，内容仅为仓库内置合成数据。JSON 记录采集版本、时间、视口和断言；概览截图包含横向溢出的右侧面板并截取至 960px 高；交互图仅截取镜像面板。时间、动画及计数随运行变化，复现与运行环境见 Demo 说明。

## Included capture runtime

The included screenshots run the 0.11.0 application source on the existing local `dom-mirror:optimized` dependency runtime. The application files were copied into a new `dom-mirror:docs` image, and `npm ls --omit=dev` verified the unchanged pinned dependencies. The final capture script was mounted read-only. This avoids a stalled fresh dependency download; it is not evidence that a fresh build of the standard Dockerfile completed. The container had no external network or published ports and was removed after capture. See `demo-runtime.json` for image identifiers.

本次截图运行 0.11.0 应用代码，依赖复用本地已有的锁定版本运行时；复制应用代码后执行 `npm ls --omit=dev` 验证，最终截图脚本只读挂载。此方式避开了停滞的全新依赖下载，不作为标准 Dockerfile 全新构建成功的证据。容器无外网、无宿主端口，采集后已删除，镜像标识记录在 `demo-runtime.json`。

## Final generation prompts

### Logo

> Use case: logo-brand. Create a polished original standalone logomark for the open-source Node.js library dom-mirror, which mirrors a server-side browser's DOM into a client browser. A spare geometric symbol of two offset browser panes reflected around a narrow central axis, with a subtle shared negative-space M. Precise flat vector-like edges, coherent bold silhouette, instantly readable at 48px, sophisticated developer-tool identity. Restrained dark ink and blue accent, use contrast that stays legible on white and dark README backgrounds. No text, no wordmark, no letters added as text, no shield, no padlock, no mascot, no mockup, no border surrounding the canvas, no drop shadows. Center one single mark with generous transparent padding. Real transparent background; deliver a square PNG.

### Illustration

> Use case: stylized-concept. Asset type: wide GitHub README editorial illustration for the open-source dom-mirror library. Show two architectural browser planes facing one another across a spacious horizontal gap: on one side an orderly wireframe tree of DOM nodes and layered CSS sheets inside a browser plane, on the other a reflected fully assembled composition of matching rectangular interface blocks. Between them a restrained flowing ribbon of small geometric patch fragments, with a subtle returning input line. Visual metaphor for DOM mirroring and incremental updates, not a technical claim or screenshot. Elegant flat/isometric technical illustration, exceptionally clean composition, crisp linework, generous negative space, pale off-white background, charcoal outlines with restrained blue accents, no gradients dominating the work. Wide 16:9 landscape. No text at all, no letters, no logos, no shields or locks, no cybersecurity clichés, no fabricated terminal output or application UI screenshot, no busy decorative particles. The drawing should look composed and intentional on a software library README.
