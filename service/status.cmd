@echo off
chcp 65001 >nul
setlocal
echo ==== 计划任务状态 ====
schtasks /Query /TN "RiichiScoreboard" /FO LIST 2>nul | findstr /C:"Status" /C:"状态"
echo.
echo ==== 8080 端口监听 ====
netstat -ano | findstr :8080 | findstr LISTENING
echo.
echo ==== 手机访问地址 ====
if exist "%~dp0..\runtime\node.exe" (
  "%~dp0..\runtime\node.exe" "%~dp0urls.js"
) else (
  echo   找不到 runtime\node.exe
)
echo.
echo ==== 内网穿透（樱花frp）====
if exist "%~dp0frpc.ini" (
  tasklist /FI "IMAGENAME eq frpc.exe" 2>nul | findstr /I "frpc.exe" >nul && (
    echo   进程状态: 正在运行
  ) || (
    echo   进程状态: 未运行
  )
  echo   配置文件: service\frpc.ini
  echo   隧道最近日志:
  if exist "%~dp0..\server.log" (
    findstr /C:"隧道启动成功" /C:"使用 >>" /C:"启动失败" "%~dp0..\server.log" 2>nul
  )
) else (
  echo   未配置。要用外网访问请按 README 第三节配置 service\frpc.ini
)
echo.
pause
