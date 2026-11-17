@echo off
chcp 65001 >nul
echo 正在重启麻将服务（含内网穿透）...
schtasks /End /TN "RiichiScoreboard" >nul 2>&1
ping -n 3 127.0.0.1 >nul
schtasks /Run /TN "RiichiScoreboard" >nul 2>&1
ping -n 4 127.0.0.1 >nul
echo.
echo --- 局域网地址 ---
call "%~dp0status.cmd" <nul 2>nul
echo.
echo 完成。若内网穿透已配置，稍等几秒它会在 server.log 里打印分配到的公网地址。
pause
