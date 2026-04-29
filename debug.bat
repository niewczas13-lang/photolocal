@echo off
echo Uruchamianie trybu deweloperskiego Photo Local...

start "Photo Local Backend (Dev)" cmd /k "cd backend && npm run dev"
start "Photo Local Frontend (Dev)" cmd /k "cd frontend && npm run dev"

echo ----------------------------------------------------
echo Serwery Dev uruchomione w oddzielnych oknach.
echo Frontend (Vite) uruchamia sie na porcie 4874 (http://localhost:4874/)
echo Backend uruchamia sie na porcie 4873
echo ----------------------------------------------------
pause
