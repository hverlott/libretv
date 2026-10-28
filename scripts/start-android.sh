#!/data/data/com.termux/files/usr/bin/sh
# Single-instance launcher; keep the lock across the supervisor and its children.
export PATH=/data/data/com.termux/files/usr/bin:/data/data/com.termux/files/usr/bin/applets
export LD_LIBRARY_PATH=/data/data/com.termux/files/usr/lib
export TMPDIR=/data/data/com.termux/files/usr/tmp
export LANG=en_US.UTF-8
export PORT=8080
export HOSTNAME=0.0.0.0
export NODE_ENV=production
cd /data/data/com.termux/files/home/libretv || exit 1
mkdir -p .runtime
exec 9>.runtime/termux-server.lock
flock -n 9 || { echo 'LibreTV supervisor is already running'; exit 0; }
command -v termux-wake-lock >/dev/null 2>&1 && termux-wake-lock 2>/dev/null
exec node scripts/termux-supervisor.cjs
