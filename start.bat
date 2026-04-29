@echo off
echo Budowanie i uruchamianie aplikacji Photo Local...

echo [1/2] Budowanie Frontend...
cd frontend
call npm run build
cd ..

echo [2/2] Budowanie Backend...
cd backend
call npm run build
cd ..

echo Uruchamianie serwera w tle...
powershell -WindowStyle Hidden -Command "Start-Process node -ArgumentList 'dist/server.js' -WorkingDirectory '%~dp0backend' -WindowStyle Hidden"

echo ----------------------------------------------------
echo Serwer zostal pomyslnie zbudowany i uruchomiony calkowicie w tle!
echo Strona dostepna pod adresem: http://localhost:4873/
echo 
echo Zamknij to okno (lub nacisnij dowolny klawisz) - aplikacja dziala w tle.
echo Aby ja zatrzymac, uzyj pliku stop.bat.
echo ----------------------------------------------------
pause
