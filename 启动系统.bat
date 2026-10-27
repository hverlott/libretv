@echo off
REM ============================================================
REM  LibreTV 启动系统（双击运行）
REM
REM  流程：定位 node → 后台启动 → 独立进程复检 → 若被环境回收
REM  则自动转为前台模式。
REM  复检必须在 start 返回后另起进程做：只有父进程退出后，
REM  才能发现「子进程被连带回收」的情况。
REM
REM  停止服务：双击「停止系统.bat」
REM ============================================================
setlocal
cd /d "%~dp0"

REM 定位 node（不依赖 PATH，见 scripts\find-node.bat）
call "%~dp0scripts\find-node.bat"
if errorlevel 1 (
  echo.
  pause
  exit /b 1
)

if not exist ".env" (
  echo [!] 未找到 .env，正在从 .env.example 创建...
  copy ".env.example" ".env" >nul
  echo [!] 请编辑 .env 中的 PASSWORD 后重新运行本脚本。
  pause
  exit /b 1
)

"%NODE_EXE%" "scripts\ctl.mjs" start %*
if errorlevel 1 (
  echo.
  echo [-] 启动失败，详情见上方输出与 .runtime\libretv.log
  pause
  exit /b 1
)

REM 独立进程复检
"%NODE_EXE%" "scripts\ctl.mjs" verify >nul 2>nul
if errorlevel 1 (
  echo.
  echo [*] 当前环境会在父进程退出时回收子进程，切换为前台模式...
  echo [*] 请保持本窗口打开；关闭窗口即停止服务。
  echo.
  "%NODE_EXE%" "scripts\ctl.mjs" start --foreground %*
  goto :eof
)

echo.
echo ============================================================
echo   服务已启动
echo   地址：http://localhost:8080
echo   停止：双击「停止系统.bat」
echo   状态：双击「查看状态.bat」
echo ============================================================
echo.
echo [*] 本窗口 8 秒后自动关闭，服务在后台继续运行。
timeout /t 8 >nul
endlocal
