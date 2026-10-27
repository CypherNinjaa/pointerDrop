@echo off
setlocal
title AirDrop-LAN-Warp: Disable Automatic Startup
echo ===============================================================================
echo  AirDrop-LAN-Warp: Remove Background Auto-Start
echo ===============================================================================
echo.

set "STARTUP_FOLDER=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "SHORTCUT_PATH=%STARTUP_FOLDER%\PointerDropTurbo.lnk"

if exist "%SHORTCUT_PATH%" (
  del /f /q "%SHORTCUT_PATH%"
  echo [SUCCESS] Removed PointerDropTurbo from Windows Startup.
) else (
  echo PointerDropTurbo was not found in Startup folder.
)

echo.
pause
