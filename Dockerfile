# WAF RBI（dom-mirror）——仓库自洽构建
# 像素流通道（jpeg/webp/h264）已移除：dom（真文本镜像，默认）+ frame（像素直出兜底）。
# 混淆字体池（assets/obf）不入库：缺省时引擎自动降级为"混淆关闭"；要开启先跑
#   python3 tools/build_obf_font.py 抽面 + tools/bake_pool.py 烘焙种子池（详见 README）
FROM ghcr.io/puppeteer/puppeteer:25.16.0

USER root
RUN sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources \
 && apt-get update \
 && apt-get install -y --no-install-recommends fonts-noto-cjk fonts-noto-color-emoji fonts-symbola \
      python3-fonttools python3-brotli \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_PATH=/home/pptruser/node_modules \
    NODE_ENV=production \
    PUPPETEER_CACHE_DIR=/home/pptruser/.cache/puppeteer \
    PUPPETEER_SKIP_DOWNLOAD=true

WORKDIR /app
COPY index.js index.d.ts server.js package.json package-lock.json ./
COPY demo ./demo
COPY lib ./lib
COPY client ./client
COPY protected ./protected
COPY assets ./assets
COPY tools ./tools
COPY test/fixtures ./test/fixtures

RUN npm ci --omit=dev \
 && node -e "(async () => {const p=require('puppeteer');require('fs').accessSync(await p.executablePath());require('ws');const s=require('sharp');console.log('deps ok, sharp', s.versions.vips)})().catch(e => {console.error(e.message);process.exit(1)})"

EXPOSE 8088
# 以非 root 运行；Chromium sandbox 需要 user namespace，运行时挂 docker/seccomp-chromium.json
USER pptruser
CMD ["node", "demo/server.js"]
