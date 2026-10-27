@echo off
REM ============================================================
REM  定位 node.exe —— 结果写入变量 NODE_EXE
REM  用法：call "%~dp0scripts\find-node.bat"
REM  成功 exit /b 0，失败 exit /b 1
REM
REM  本文件与调用它的 .bat 都必须保存为 GBK(ANSI) 编码，
REM  否则 cmd 按 936 代码页解析会显示乱码。
REM ============================================================
set "NODE_EXE="

REM 1) 已经在 PATH 里
for /f "delims=" %%i in ('where node 2^>nul') do (
  if not defined NODE_EXE set "NODE_EXE=%%i"
)
if defined NODE_EXE goto :found

REM 2) 官方安装包默认位置
if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if defined NODE_EXE goto :found

REM 3) WorkBuddy 内置 node（本机实际安装位置）
if exist "%USERPROFILE%\.workbuddy\binaries\node\versions" (
  for /f "delims=" %%i in ('dir /b /o:n "%USERPROFILE%\.workbuddy\binaries\node\versions" 2^>nul') do (
    if exist "%USERPROFILE%\.workbuddy\binaries\node\versions\%%i\node.exe" set "NODE_EXE=%USERPROFILE%\.workbuddy\binaries\node\versions\%%i\node.exe"
  )
)
if defined NODE_EXE goto :found

REM 4) nvm-windows / Volta / fnm
if not defined NODE_EXE if exist "%NVM_HOME%\node.exe" set "NODE_EXE=%NVM_HOME%\node.exe"
if not defined NODE_EXE if exist "%NVM_SYMLINK%\node.exe" set "NODE_EXE=%NVM_SYMLINK%\node.exe"
if not defined NODE_EXE if exist "%VOLTA_HOME%\bin\node.exe" set "NODE_EXE=%VOLTA_HOME%\bin\node.exe"
if defined NODE_EXE goto :found

echo [!] 未找到 node.exe
echo.
echo     已依次查找：
echo       - PATH
echo       - %%ProgramFiles%%\nodejs
echo       - %%LOCALAPPDATA%%\Programs\nodejs
echo       - %%USERPROFILE%%\.workbuddy\binaries\node\versions
echo       - nvm / Volta
echo.
echo     请安装 Node.js 18+ : https://nodejs.org
exit /b 1

:found
exit /b 0
