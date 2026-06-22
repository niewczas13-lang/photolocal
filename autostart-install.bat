@echo off
setlocal
cd /d "%~dp0"
echo Instalacja autostartu Photo Local...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install-autostart.ps1"
echo.
pause
