@echo off
chcp 65001 >nul
setlocal
for %%I in ("%~dp0..") do set "ROOT=%%~fI"
cd /d "%ROOT%"

:: 找 node 的顺序：项目自带的 runtime\node.exe -> 系统 PATH 里的 node
set "NODE="
if exist "%ROOT%\runtime\node.exe" set "NODE=%ROOT%\runtime\node.exe"
if not defined NODE for %%I in (node.exe) do if not "%%~$PATH:I"=="" set "NODE=%%~$PATH:I"
if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE (
  echo [%date% %time%] 找不到 node.exe，无法启动 >> "%ROOT%\server.log"
  exit /b 1
)

"%NODE%" "%~dp0supervisor.js"
exit /b %ERRORLEVEL%
