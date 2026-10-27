#!/usr/bin/env bash
# LibreTV 生产环境启动脚本（Windows Git Bash / Linux / macOS 通用）
# 用法: ./start.sh [端口]   默认 8080
set -e

cd "$(dirname "$0")"

PORT="${1:-8080}"

if [ ! -f .env ]; then
  echo "[!] 未找到 .env，正在从 .env.example 创建..."
  cp .env.example .env
  echo "[!] 请编辑 .env 中的 PASSWORD 后再启动。"
  exit 1
fi

# 加载 .env 中的配置
set -a
# shellcheck disable=SC1091
. ./.env
set +a

if [ -z "$PASSWORD" ]; then
  echo "[!] .env 中未设置 PASSWORD，无法启动。"
  exit 1
fi

echo "[*] 正在构建（若已构建过会很快跳过）..."
npm run build

echo "[*] 启动 LibreTV，端口 ${PORT}，访问密码 ${PASSWORD}"
exec npx next start -p "${PORT}"
