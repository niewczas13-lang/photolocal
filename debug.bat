@echo off
echo Uruchamianie trybu deweloperskiego Photo Local...

start "Photo Local Backend (Dev)" cmd /k "cd /d %~dp0backend && npm run dev"
start "Photo Local Frontend (Dev)" cmd /k "cd /d %~dp0frontend && npm run dev -- --host 0.0.0.0"

echo ----------------------------------------------------
echo Serwery Dev uruchomione w oddzielnych oknach.
echo Frontend (Vite) uruchamia sie na porcie 4874:
echo   lokalnie: http://localhost:4874/
echo   z sieci:  http://TWOJE-IPV4:4874/
echo Backend uruchamia sie na porcie 4873 i slucha na 0.0.0.0
echo ----------------------------------------------------
pause
