@echo off
chcp 936 >nul
title LibreTV - 放行 Windows 防火墙
echo.
echo   为 LibreTV 添加一条防火墙入站规则，让同一局域网内的
echo   手机 / 电视 / 平板可以访问本机服务。
echo.

net session >nul 2>&1
if errorlevel 1 (
  echo [-] 需要管理员权限。
  echo     请右键本文件，选择“以管理员身份运行”。
  echo.
  pause
  exit /b 1
)

rem 端口取自 .env 的 PORT，没有则用 8080
set "LT_PORT="
if exist "%~dp0.env" (
  for /f "usebackq tokens=1,2 delims==" %%a in (`findstr /b /c:"PORT=" "%~dp0.env"`) do set "LT_PORT=%%b"
)
if not defined LT_PORT set "LT_PORT=8080"
set "LT_PORT=%LT_PORT: =%"
echo [*] 目标端口：%LT_PORT%

netsh advfirewall firewall delete rule name="LibreTV %LT_PORT%" >nul 2>&1
netsh advfirewall firewall add rule name="LibreTV %LT_PORT%" description="LibreTV 局域网访问" dir=in action=allow protocol=TCP localport=%LT_PORT% profile=any >nul
if errorlevel 1 (
  echo [-] 添加失败。可能被组策略或安全软件拦截，请手动放行 TCP %LT_PORT% 端口。
  echo.
  pause
  exit /b 1
)

echo [+] 已放行 TCP %LT_PORT%
echo.
echo   说明：规则对所有网络类型生效，是为了避免「家里的 WiFi 被 Windows
echo   判定为公用网络、怎么都连不上」。服务本身仍然需要密码才能使用。
echo   如果不想在公共 WiFi 下暴露，可删除后只对专用网络放行：
echo     netsh advfirewall firewall delete rule name="LibreTV %LT_PORT%"
echo     netsh advfirewall firewall add rule name="LibreTV %LT_PORT%" dir=in action=allow protocol=TCP localport=%LT_PORT% profile=private,domain
echo.
echo   手机端打开：http://本机局域网IP:%LT_PORT%
echo   （地址见「查看状态.bat」输出，或站内 /system 页）
echo.
pause
