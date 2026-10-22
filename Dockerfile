# dom-mirror — RBI (remote browser isolation) reference implementation
# 基础镜像自带 Node + Chromium + puppeteer；再补中文字体与 ws 库
FROM ghcr.io/puppeteer/puppeteer:24.7.0

USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends fonts-noto-cjk \
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

RUN node -e "require('puppeteer');require('ws');console.log('deps ok')"

EXPOSE 8088
CMD ["node", "server.js"]
