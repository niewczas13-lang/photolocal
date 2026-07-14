@echo off
setlocal
cd /d "%~dp0"

echo Audyt zdjec Photo Local...
echo.
echo Ten skrypt porownuje rekordy zdjec w bazie z plikami na dysku.
echo Niczego nie usuwa ani nie przenosi.
echo.

cd /d "%~dp0backend"
call npm.cmd run audit:photo-files
if errorlevel 1 goto error

echo.
echo Audyt zakonczony.
pause
exit /b 0

:error
echo.
echo [BLAD] Audyt przerwany. Sprawdz komunikat powyzej.
pause
exit /b 1
