@echo off
setlocal DisableDelayedExpansion
echo Zatrzymywanie procesow Photo Local...

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop-native-server.ps1"
if errorlevel 1 goto error

echo.
echo Operacja zakonczona. Serwer Photo Local zostal zatrzymany.
pause
exit /b 0

:error
echo Zatrzymanie przerwane. Docker i niepotwierdzone procesy nie sa zatrzymywane.
pause
exit /b 1
