@echo off
REM LibreTV 生产环境启动脚本（Windows CMD / PowerShell）
REM 用法: start.bat [端口]   默认 8080
setlocal

cd /d "%~dp0"

set "PORT=%~1"
if "%PORT%"=="" set "PORT=8080"

if not exist ".env" (
  echo [!] 未找到 .env，正在从 .env.example 创建...
  copy ".env.example" ".env" >nul
  echo [!] 请编辑 .env 中的 PASSWORD 后再启动。
  exit /b 1
)

echo [*] 正在构建（若已构建过会很快跳过）...
call npm run build
if errorlevel 1 exit /b 1

echo [*] 启动 LibreTV，端口 %PORT%
call npx next start -p %PORT%
