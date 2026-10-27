@echo off
REM ============================================================
REM  LibreTV 停止系统（双击运行）
REM  按进程树终止，不会留下孤儿进程继续占用端口。
REM ============================================================
setlocal
cd /d "%~dp0"

call "%~dp0scripts\find-node.bat"
if errorlevel 1 (
  echo.
  pause
  exit /b 1
)

"%NODE_EXE%" "scripts\ctl.mjs" stop %*
if errorlevel 1 (
  echo.
  echo [-] 停止失败，详情见上方输出与 .runtime\libretv.log
  pause
  exit /b 1
)

echo.
echo [*] 服务已停止。重新启动：双击「启动系统.bat」
timeout /t 5 >nul
endlocal
