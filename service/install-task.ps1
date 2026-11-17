# 用 task.xml 模板生成一份带真实路径的计划任务 XML（UTF-16LE），并回显它的路径。
# 由 install.cmd 调用：powershell -File install-task.ps1
$ErrorActionPreference = 'Stop'

$serviceDir = $PSScriptRoot
$root       = Split-Path -Parent $serviceDir
$runCmd     = Join-Path $serviceDir 'run.cmd'
$template   = Join-Path $serviceDir 'task.xml'
$outFile    = Join-Path $env:TEMP 'riichi-scoreboard-task.xml'

if (-not (Test-Path $runCmd)) { throw "找不到 $runCmd" }
if (-not (Test-Path $template)) { throw "找不到 $template" }

$xml = Get-Content -Raw -Encoding UTF8 $template
$xml = $xml.Replace('__RUN_CMD__', [System.Security.SecurityElement]::Escape($runCmd))
$xml = $xml.Replace('__WORKDIR__', [System.Security.SecurityElement]::Escape($root))

# schtasks /Create /XML 需要 UTF-16
Set-Content -Path $outFile -Value $xml -Encoding Unicode -NoNewline

Write-Output $outFile
