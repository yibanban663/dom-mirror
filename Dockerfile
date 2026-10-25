# WAF RBI（dom-mirror）——仓库自洽构建
# ffmpeg 不入库：CI/本地先跑 ./get-ffmpeg.sh 下载静态 ffmpeg 到 bin/（只用 DOM 镜像可不装）
# 混淆字体池（assets/obf）不入库：缺省时引擎自动降级为"混淆关闭"；要开启先跑
#   python3 tools/build_obf_font.py 抽面 + tools/bake_pool.py 烘焙种子池（详见 README）
FROM ghcr.io/puppeteer/puppeteer:24.7.0

USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends fonts-noto-cjk fonts-noto-color-emoji fonts-symbola \
      python3-fonttools python3-brotli \
 && rm -rf /var/lib/apt/lists/*
COPY bin/ffmpeg /usr/local/bin/ffmpeg
RUN chmod +x /usr/local/bin/ffmpeg && ffmpeg -version | head -1

ENV NODE_PATH=/home/pptruser/node_modules \
    NODE_ENV=production \
    PUPPETEER_EXECUTABLE_PATH=/home/pptruser/.cache/puppeteer/chrome/linux-135.0.7049.95/chrome-linux64/chrome \
    PUPPETEER_SKIP_DOWNLOAD=true

WORKDIR /app
COPY server.js package.json ./
COPY client ./client
COPY protected ./protected
COPY assets ./assets
COPY tools ./tools

RUN npm install sharp --no-save --unsafe-perm 2>&1 | tail -1 \
 && node -e "require('puppeteer');require('ws');const s=require('sharp');console.log('deps ok, sharp', s.versions.vips)"

EXPOSE 8088
CMD ["node", "server.js"]
