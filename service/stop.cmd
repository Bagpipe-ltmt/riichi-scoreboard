@echo off
chcp 65001 >nul
schtasks /End /TN "RiichiScoreboard"
echo 已停止服务。
pause
