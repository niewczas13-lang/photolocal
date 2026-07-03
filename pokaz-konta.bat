@echo off
setlocal
cd /d "%~dp0"

set "PROMPT_MODE=1"
if not "%~1"=="" set "PROMPT_MODE=0"

echo Konta Photo Local...
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\pokaz-konta.ps1" %*
if errorlevel 1 goto error

echo.
if "%PROMPT_MODE%"=="1" pause
exit /b 0

:error
echo.
echo [BLAD] Nie udalo sie wyswietlic kont. Sprawdz komunikat powyzej.
if "%PROMPT_MODE%"=="1" pause
exit /b 1
