@echo off
setlocal EnableExtensions
chcp 65001 >nul
title Brana VPN 本地核心（手动模式，关闭窗口即停止）
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 未检测到 Node.js，请先安装 LTS 版本：https://nodejs.org/zh-cn/download
  start "" "https://nodejs.org/zh-cn/download"
  pause
  exit /b 1
)
node brana-core.js %*
pause
