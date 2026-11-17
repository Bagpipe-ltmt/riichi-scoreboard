@echo off
chcp 65001 >nul
setlocal
for %%I in ("%~dp0..") do set "ROOT=%%~fI"
cd /d "%ROOT%"

set "NODE="
if exist "%ROOT%\runtime\node.exe" set "NODE=%ROOT%\runtime\node.exe"
if not defined NODE if exist "C:\Users\hzy29\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" set "NODE=C:\Users\hzy29\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
if not defined NODE for %%I in (node.exe) do if not "%%~$PATH:I"=="" set "NODE=%%~$PATH:I"
if not defined NODE (
  echo [%date% %time%] 找不到 node.exe，无法启动 >> "%ROOT%\server.log"
  exit /b 1
)

"%NODE%" "%~dp0supervisor.js"
exit /b %ERRORLEVEL%
