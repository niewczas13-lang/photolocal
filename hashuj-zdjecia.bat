@echo off
setlocal
cd /d "%~dp0"

echo Haszowanie zdjec Photo Local...
echo.
echo Ten skrypt skanuje foldery przypisane do aktualnych projektow,
echo zapisuje hashe do cache w bazie i uzupelnia brakujace photos.content_hash.
echo Niczego nie usuwa ani nie przenosi.
echo.

cd /d "%~dp0backend"
call npm.cmd run hash:photos
if errorlevel 1 goto error

echo.
echo Haszowanie zakonczone.
pause
exit /b 0

:error
echo.
echo [BLAD] Haszowanie przerwane. Sprawdz komunikat powyzej.
pause
exit /b 1
