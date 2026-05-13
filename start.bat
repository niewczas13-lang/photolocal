@echo off
setlocal
cd /d "%~dp0"
echo Budowanie i uruchamianie aplikacji Photo Local...

echo [1/2] Budowanie Frontend...
cd /d "%~dp0frontend"
call npm run build
if errorlevel 1 goto error
cd /d "%~dp0"

echo [2/2] Budowanie Backend...
cd /d "%~dp0backend"
call npm run build
if errorlevel 1 goto error
cd /d "%~dp0"

echo Uruchamianie serwera w tle...
if not exist "%~dp0logs" mkdir "%~dp0logs"
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process node -ArgumentList 'dist/server.js' -WorkingDirectory '%~dp0backend' -WindowStyle Hidden -RedirectStandardOutput '%~dp0logs\server.out.log' -RedirectStandardError '%~dp0logs\server.err.log'"
if errorlevel 1 goto error

echo ----------------------------------------------------
echo Serwer zostal pomyslnie zbudowany i uruchomiony calkowicie w tle!
echo Strona dostepna pod adresem: http://localhost:4873/
echo Z innego komputera w tej samej sieci: http://TWOJE-IPV4:4873/
echo Logi startu:
echo   %~dp0logs\server.out.log
echo   %~dp0logs\server.err.log
echo 
echo Zamknij to okno (lub nacisnij dowolny klawisz) - aplikacja dziala w tle.
echo Aby ja zatrzymac, uzyj pliku stop.bat.
echo ----------------------------------------------------
pause
exit /b 0

:error
echo.
echo [BLAD] Start nie powiodl sie. Zobacz komunikat powyzej.
echo Okno zostaje otwarte, zebys mogl skopiowac blad.
pause
exit /b 1
