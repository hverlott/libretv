#!/data/data/com.termux/files/usr/bin/sh
# Termux:Boot 开机自启入口（~/.termux/boot/ 下按文件名顺序执行）
# 只负责把输出落到日志；唤醒锁、日志轮转、崩溃重启都在 start-server.sh 里。
LOG=/data/data/com.termux/files/usr/tmp/lb-boot.log
exec /data/data/com.termux/files/home/start-server.sh >> "$LOG" 2>&1
