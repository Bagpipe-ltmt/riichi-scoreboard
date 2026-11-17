@echo off
chcp 65001 >nul
schtasks /Run /TN "RiichiScoreboard"
echo 已发出启动指令，约 2 秒后可用。
pause
