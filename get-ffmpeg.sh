#!/bin/sh
# 下载静态 ffmpeg 到 bin/（H.264 通道用；只用 DOM 镜像/JPEG/WebP 可跳过）
set -e
mkdir -p bin
cd bin
curl -sL --fail -o ffmpeg.tar.xz https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz
tar -xf ffmpeg.tar.xz --strip-components=1 --wildcards '*/ffmpeg'
rm -f ffmpeg.tar.xz
chmod +x ffmpeg
./ffmpeg -version | head -1
