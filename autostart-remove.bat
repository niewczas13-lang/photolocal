@echo off
setlocal
cd /d "%~dp0"
echo Usuwanie autostartu Photo Local...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\uninstall-autostart.ps1"
echo.
pause
