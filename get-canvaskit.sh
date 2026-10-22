#!/bin/sh
# 下载 CanvasKit（Skia-WASM 引擎，skiadom 模式用；只用像素/DOM 通道可跳过）
set -e
mkdir -p ck
cd ck
curl -sL --fail -o ck.tgz https://registry.npmjs.org/canvaskit-wasm/-/canvaskit-wasm-0.42.0.tgz
tar -xzf ck.tgz
find package -name 'canvaskit.js' -exec cp {} . \;
find package -name 'canvaskit.wasm' -exec cp {} . \;
rm -rf package ck.tgz
ls -la
