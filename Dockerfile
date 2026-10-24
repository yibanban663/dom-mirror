# 虚影 RBI 帧流 PoC
# 基础镜像自带 Node + Chromium + puppeteer；再补中文字体与 ws 库
FROM ghcr.io/puppeteer/puppeteer:24.7.0

USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends fonts-noto-cjk fonts-noto-color-emoji fonts-symbola \
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
COPY ck ./ck

# sharp：Node 端原生 PNG 解码/裁剪/编码（编码-解码范式的差分引擎跑在进程内，
# 不经过 CDP evaluate 传大参数——后者是 ~60ms/帧的吞吐瓶颈，sharp 全链路 <10ms）
RUN npm install sharp --no-save --unsafe-perm 2>&1 | tail -1 \
 && node -e "require('puppeteer');require('ws');const s=require('sharp');console.log('deps ok, sharp', s.versions.vips)"

EXPOSE 8088
CMD ["node", "server.js"]
