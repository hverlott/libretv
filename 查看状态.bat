@echo off
REM ============================================================
REM  LibreTV 查看运行状态（双击运行）
REM ============================================================
setlocal
cd /d "%~dp0"

call "%~dp0scripts\find-node.bat"
if errorlevel 1 (
  echo.
  pause
  exit /b 1
)

"%NODE_EXE%" "scripts\ctl.mjs" status
echo.
echo [可用命令]
echo   启动: "%NODE_EXE%" scripts\ctl.mjs start
echo   停止: "%NODE_EXE%" scripts\ctl.mjs stop
echo   重启: "%NODE_EXE%" scripts\ctl.mjs restart
echo   日志: "%NODE_EXE%" scripts\ctl.mjs logs
echo.
echo [已使用的 node]
echo   %NODE_EXE%
echo.
pause
endlocal
