#!/data/data/com.termux/files/usr/bin/sh
# LibreTV on Termux —— 唯一启动入口
# 开机自启（Termux:Boot）与手动 `lb` 共用这一个文件，由 npm run deploy:android 同步。

export PREFIX=/data/data/com.termux/files/usr
export HOME=/data/data/com.termux/files/home
export PATH=$PREFIX/bin:$PREFIX/bin/applets
export LD_LIBRARY_PATH=$PREFIX/lib
export TMPDIR=$PREFIX/tmp
export LANG=en_US.UTF-8

export PORT="${PORT:-8080}"
export HOSTNAME="${HOSTNAME:-0.0.0.0}"    # 手机要对外提供访问，必须监听 0.0.0.0
export NODE_ENV=production

# 堆上限：手机内存宽裕，但没必要让 Node 无限增长。
# 实测常驻 RSS 100~140 MB，1 GB 堆绰绰有余，GC 也会更早回收。
export NODE_OPTIONS="--max-old-space-size=1024"

LOG="$PREFIX/tmp/lb-boot.log"

# 日志轮转：超过 5 MB 清空。
# 早期实测约 200 KB/小时，一年能累积到 1~2 GB。
# 用清空而不是删除：进程持有这个文件的 fd，删了会丢失重定向（日志从此不落盘）。
if [ -f "$LOG" ]; then
  _sz=$(wc -c < "$LOG" 2>/dev/null || echo 0)
  if [ "$_sz" -gt 5242880 ]; then
    : > "$LOG"
    echo "[$(date '+%F %T')] 日志超过 5MB，已清空" >> "$LOG"
  fi
fi

# 唤醒锁：没有它，息屏进入 Doze 后网络请求会被推迟到维护窗口。
# 这是「手机不亮屏也能随时打开」的关键，去掉它会退化成首包超时。
command -v termux-wake-lock >/dev/null 2>&1 && termux-wake-lock 2>/dev/null

cd /data/data/com.termux/files/home/libretv || exit 1

# 端口已被占用 = 已有实例在跑。直接退出，避免双实例互相抢端口后无限崩溃重启。
if command -v curl >/dev/null 2>&1; then
  if curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/"; then
    echo "[$(date '+%F %T')] 端口 $PORT 已有服务在运行，本次启动跳过"
    exit 0
  fi
fi

echo "[$(date '+%F %T')] 启动 LibreTV（端口 $PORT，堆上限 1GB）"

while true; do
  node server.js
  code=$?
  # 0 = 正常退出，130 = Ctrl+C：这两种不再重启，其余（崩溃 / 被系统杀）3 秒后重来
  if [ "$code" -eq 0 ] || [ "$code" -eq 130 ]; then
    echo "[$(date '+%F %T')] 已退出（$code），不再重启"
    break
  fi
  echo "[$(date '+%F %T')] 异常退出（$code），3 秒后重启"
  sleep 3
done
