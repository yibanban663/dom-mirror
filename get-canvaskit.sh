#!/bin/sh
# Download CanvasKit (Skia-WASM engine, skiadom mode; skip if only using pixel/dom channels)
set -e
mkdir -p ck
cd ck
curl -sL --fail -o ck.tgz https://registry.npmjs.org/canvaskit-wasm/-/canvaskit-wasm-0.42.0.tgz
tar -xzf ck.tgz
find package -name 'canvaskit.js' -exec cp {} . \;
find package -name 'canvaskit.wasm' -exec cp {} . \;
rm -rf package ck.tgz
ls -la
