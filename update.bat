@echo off
setlocal DisableDelayedExpansion

rem Parse the complete continuation before git pull can replace this batch file.
(
  cd /d "%~dp0"
  if errorlevel 1 exit /b 1
  echo Aktualizacja produkcyjnego Photo Local w Dockerze...
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\update-production-app.ps1"
  if errorlevel 2 (
    echo Nie znaleziono produkcyjnej aplikacji Docker. Nie zatrzymano zadnej aplikacji.
    pause
    exit /b 2
  )
  if errorlevel 1 (
    echo Aktualizacja przerwana. Sprawdz kod bledu powyzej.
    pause
    exit /b 1
  )
  echo Aktualizacja zakonczona.
  pause
  exit /b 0
)
