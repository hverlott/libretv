#!/usr/bin/env bash
# ============================================================
#  LibreTV 停止系统（双击 / 命令行运行）
# ============================================================
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "[!] 未找到 node 命令，请先安装 Node.js 18+ 并加入 PATH。"
  exit 1
fi

exec node scripts/ctl.mjs stop "$@"
