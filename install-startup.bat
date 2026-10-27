@echo off
setlocal
title AirDrop-LAN-Warp: Enable Automatic Startup
echo ===============================================================================
echo  AirDrop-LAN-Warp: One-Click Background Auto-Start Setup
echo ===============================================================================
echo.
echo This script sets up LAN Turbo to automatically start on boot in the background.
echo You will NEVER have to run "npm run turbo" manually again.
echo.

set "TARGET_BAT=%~dp0start-turbo.bat"
set "VBS_SCRIPT=%~dp0scripts\run-silent.vbs"
set "STARTUP_FOLDER=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "SHORTCUT_PATH=%STARTUP_FOLDER%\PointerDropTurbo.lnk"

:: Create silent runner VBS if not already created
if not exist "%VBS_SCRIPT%" (
  echo Creating background silent launcher...
  echo Set WshShell = CreateObject("WScript.Shell") > "%VBS_SCRIPT%"
  echo WshShell.Run """%TARGET_BAT%""", 0, False >> "%VBS_SCRIPT%"
)

:: Create Windows Shortcut in Startup folder using PowerShell
powershell -NoProfile -Command "$ws = New-Object -ComObject WScript.Shell; $s = $ws.CreateShortcut('%SHORTCUT_PATH%'); $s.TargetPath = 'wscript.exe'; $s.Arguments = '\"%VBS_SCRIPT%\"'; $s.WorkingDirectory = '%~dp0'; $s.Save()"

if %errorlevel% equ 0 (
  echo.
  echo [SUCCESS] LAN Turbo Auto-Start has been installed!
  echo Location: %SHORTCUT_PATH%
  echo.
  echo From now on, whenever your computer turns on, LAN Turbo runs in the
  echo background on port 8787 automatically.
  echo.
  echo Starting background service right now...
  wscript.exe "%VBS_SCRIPT%"
  echo [ONLINE] LAN Turbo is now running in the background!
  echo You can close this window.
) else (
  echo [ERROR] Failed to create shortcut in Startup folder.
)

echo.
pause
