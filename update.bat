@echo off
setlocal

echo Aktualizacja Photo Local...

echo.
echo [1/6] Zatrzymywanie aplikacji...
call "%~dp0stop.bat"

echo.
echo [2/6] Pobieranie zmian z GitHub...
git pull --ff-only
if errorlevel 1 goto error

echo.
echo [3/6] Instalacja paczek Node...
call npm.cmd install --workspaces
if errorlevel 1 goto error

echo.
echo [4/6] Instalacja paczek Python...
python -m pip install -r "%~dp0pobierzchat\requirements.txt"
if errorlevel 1 goto error

echo.
echo [5/6] Build aplikacji...
call npm.cmd run build
if errorlevel 1 goto error

echo.
echo [6/6] Start aplikacji...
call "%~dp0start.bat"
if errorlevel 1 goto error

echo.
echo Aktualizacja zakonczona.
pause
exit /b 0

:error
echo.
echo Aktualizacja przerwana. Sprawdz blad powyzej.
pause
exit /b 1