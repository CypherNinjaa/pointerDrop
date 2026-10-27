@echo off
setlocal
title AirDrop-LAN-Warp LAN Turbo Daemon (150-250+ MB/s)
echo ===============================================================================
echo  AirDrop-LAN-Warp: Zero-Copy LAN Turbo Daemon
echo  Bypasses browser WebRTC UDP rate caps via unencrypted zero-copy TCP cut-through.
echo ===============================================================================
echo.
echo Checking Node.js installation...
where node >nul 2>nul
if %errorlevel% neq 0 (
  echo [ERROR] Node.js is not installed or not in PATH.
  echo Please install Node.js from https://nodejs.org or run pure WebRTC on GitHub Pages.
  echo.
  pause
  exit /b 1
)

echo Starting LAN Turbo Pipe on port 8787...
echo You can now use https://cypherninjaa.github.io/pointerDrop/ or local LAN URLs!
echo Keep this window open while transferring files at 150-250+ MB/s.
echo.
node "%~dp0scripts\warp-turbo.mjs"
pause
