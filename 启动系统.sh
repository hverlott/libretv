#!/usr/bin/env bash
# ============================================================
#  LibreTV 启动系统（双击 / 命令行运行）
#  用法: ./启动系统.sh [端口]
# ============================================================
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "[!] 未找到 node 命令，请先安装 Node.js 18+ 并加入 PATH。"
  exit 1
fi

if [ ! -f .env ]; then
  echo "[!] 未找到 .env，正在从 .env.example 创建..."
  cp .env.example .env
  echo "[!] 请编辑 .env 中的 PASSWORD 后重新运行本脚本。"
  exit 1
fi

# 端口参数透传给控制脚本
if [ -n "$1" ]; then
  exec node scripts/ctl.mjs start --port "$1"
else
  exec node scripts/ctl.mjs start
fi
