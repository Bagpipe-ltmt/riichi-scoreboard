@echo off
chcp 65001 >nul
net session >nul 2>&1
if errorlevel 1 (
  echo [错误] 请右键本文件 -^> 以管理员身份运行。
  pause
  exit /b 1
)
schtasks /End /TN "RiichiScoreboard" >nul 2>&1
schtasks /Delete /TN "RiichiScoreboard" /F
netsh advfirewall firewall delete rule name="RiichiScoreboard 8080" >nul 2>&1
echo 已卸载：计划任务与防火墙规则均已删除。
pause
