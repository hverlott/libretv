#!/usr/bin/env bash
# ============================================================
#  LibreTV 桌面客户端（双击 / 命令行运行）
#  用法: ./打开客户端.sh [--port 9099]
# ============================================================
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "[!] 未找到 node 命令，请先安装 Node.js 18+ 并加入 PATH。"
  exit 1
fi

if [ ! -f "client/launch.mjs" ]; then
  echo "[!] 找不到客户端脚本：client/launch.mjs"
  exit 1
fi

exec node client/launch.mjs "$@"
