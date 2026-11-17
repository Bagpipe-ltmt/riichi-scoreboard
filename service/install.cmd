@echo off
chcp 65001 >nul
setlocal
net session >nul 2>&1
if errorlevel 1 (
  echo [错误] 请右键本文件 -^> 以管理员身份运行。
  pause
  exit /b 1
)

echo [1/4] 注册计划任务 RiichiScoreboard ...
set "TASKXML="
for /f "usebackq delims=" %%X in (`powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-task.ps1"`) do set "TASKXML=%%X"
if not defined TASKXML (
  echo [错误] 生成计划任务配置失败（task.xml / install-task.ps1 缺失？）。
  pause
  exit /b 1
)
schtasks /Create /TN "RiichiScoreboard" /XML "%TASKXML%" /F
if errorlevel 1 (
  echo [错误] 计划任务注册失败。
  pause
  exit /b 1
)
del "%TASKXML%" >nul 2>&1

echo [2/4] 添加防火墙入站规则 TCP 8080 ...
netsh advfirewall firewall delete rule name="RiichiScoreboard 8080" >nul 2>&1
netsh advfirewall firewall delete rule name="立直麻将场风盘 8080" >nul 2>&1
netsh advfirewall firewall add rule name="RiichiScoreboard 8080" dir=in action=allow protocol=TCP localport=8080 >nul
if errorlevel 1 echo   [警告] 防火墙规则添加失败，手机可能连不上。

echo [3/4] 关闭睡眠（接电源时永不待机，否则人走开一会儿手机就断线）...
powercfg /change standby-timeout-ac 0 >nul 2>&1
if errorlevel 1 echo   [警告] 电源设置修改失败，请手动到「电源和睡眠」把「睡眠」设为「从不」。

echo [4/4] 启动服务 ...
schtasks /Run /TN "RiichiScoreboard" >nul
echo.
echo 完成。开机自动启动已生效，手机连接地址请运行 status.cmd 查看。
pause
