<#
.SYNOPSIS
  停止此检出登记的答辩演示进程。
#>
#Requires -Version 5.1
$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot '答辩启动.ps1') -Stop
exit $LASTEXITCODE
