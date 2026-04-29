@echo off
echo Zatrzymywanie procesow Photo Local...

:: Backend
FOR /F "tokens=5" %%T IN ('netstat -a -n -o ^| findstr :4873 ^| findstr LISTENING') DO (
    if not "%%T"=="0" (
        echo Zamykanie serwera na PID %%T ...
        TaskKill.exe /PID %%T /F >nul 2>&1
    )
)

echo.
echo Operacja zakonczona. Serwer Photo Local zostal zatrzymany.
pause
