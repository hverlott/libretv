@echo off
REM ============================================================
REM  LibreTV 桌面客户端（双击运行）
REM
REM  打开一个独立窗口，里面可以：
REM    - 查看服务状态（端口 / PID / 运行时长）
REM    - 一键开启 / 关闭 / 重启服务
REM    - 进入系统直接看电影
REM ============================================================
setlocal
cd /d "%~dp0"

call "%~dp0scripts\find-node.bat"
if errorlevel 1 (
  echo.
  pause
  exit /b 1
)

if not exist "client\launch.mjs" (
  echo [!] 找不到客户端脚本：client\launch.mjs
  pause
  exit /b 1
)

REM 面板端口被占用时提示（可能是上一个客户端没退干净）
"%NODE_EXE%" "client\launch.mjs" %*
if errorlevel 1 (
  echo.
  echo [-] 客户端启动失败，详情见上方输出
  pause
  exit /b 1
)

endlocal
