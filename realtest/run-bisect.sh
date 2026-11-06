#!/bin/bash
# run-bisect.sh <载荷集> — 清理(端口定位)→ 启动源站/网关 → probe → 收尾
SET="$1"
for p in $(lsof -tiTCP:8099 -sTCP:LISTEN 2>/dev/null) $(lsof -tiTCP:8088 -sTCP:LISTEN 2>/dev/null); do kill -9 $p 2>/dev/null; done
sleep 2
PAYLOAD_SET="$SET" nohup node attack-origin2.cjs > origin2.log 2>&1 &
sleep 1
ORIGIN_URL="http://127.0.0.1:8099/" PUPPETEER_EXECUTABLE_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" nohup node ../demo/server.js > bisect.log 2>&1 &
sleep 8
r=$(node bisect-probe.cjs)
echo "集合[$SET] → $r"
for p in $(lsof -tiTCP:8099 -sTCP:LISTEN 2>/dev/null) $(lsof -tiTCP:8088 -sTCP:LISTEN 2>/dev/null); do kill -9 $p 2>/dev/null; done
sleep 1
