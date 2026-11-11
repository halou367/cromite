@echo off
setlocal EnableExtensions
chcp 65001 >nul
title Brana VPN 本地核心 - 卸载
for %%K in ("Google\Chrome" "Google\Chrome Beta" "Google\Chrome Dev" "Google\Chrome SxS" "Chromium" "Microsoft\Edge" "Microsoft\Edge Beta" "Microsoft\Edge Dev" "BraveSoftware\Brave-Browser" "Vivaldi") do (
  reg delete "HKCU\Software\%%~K\NativeMessagingHosts\com.brana.vpn" /f >nul 2>nul
)
if exist "%LOCALAPPDATA%\BranaVPN" rmdir /s /q "%LOCALAPPDATA%\BranaVPN"
echo.
echo   已卸载 Brana VPN 本地核心（浏览器扩展本身请在扩展管理页移除）。
echo.
pause
