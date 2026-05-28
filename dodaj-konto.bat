@echo off
setlocal
cd /d "%~dp0"

set "PROMPT_MODE=1"
if not "%~1"=="" set "PROMPT_MODE=0"

echo Dodawanie konta Photo Local...
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\dodaj-konto.ps1" %*
if errorlevel 1 goto error

echo.
echo Konto zostalo dodane albo zaktualizowane.
if "%PROMPT_MODE%"=="1" pause
exit /b 0

:error
echo.
echo [BLAD] Nie udalo sie dodac konta. Sprawdz komunikat powyzej.
if "%PROMPT_MODE%"=="1" pause
exit /b 1
