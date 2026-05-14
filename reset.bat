@echo off
set "ROOT=%~dp0"

echo =======================================================
echo  UWAGA: Ten skrypt usunie baze danych Photo Local i
echo  WSZYSTKIE wgrane zdjecia.
echo.
echo  Nie usuwa profilu Chrome Google Chat, wiec nie kasuje
echo  logowania bota ani zaproszen.
echo =======================================================
echo.
set /p CHOICE="Wpisz T aby potwierdzic usuniecie: "
if /I not "%CHOICE%"=="T" goto abort

echo.
echo Usuwanie starych folderow w root (jesli istnieja)...
if exist "%ROOT%data\photo-local.sqlite" del /f /q "%ROOT%data\photo-local.sqlite"
if exist "%ROOT%data\photo-local.sqlite-shm" del /f /q "%ROOT%data\photo-local.sqlite-shm"
if exist "%ROOT%data\photo-local.sqlite-wal" del /f /q "%ROOT%data\photo-local.sqlite-wal"
if exist "%ROOT%photos" rmdir /s /q "%ROOT%photos"

echo Usuwanie wlasciwej bazy danych z backendu...
if exist "%ROOT%backend\data\photo-local.sqlite" del /f /q "%ROOT%backend\data\photo-local.sqlite"
if exist "%ROOT%backend\data\photo-local.sqlite-shm" del /f /q "%ROOT%backend\data\photo-local.sqlite-shm"
if exist "%ROOT%backend\data\photo-local.sqlite-wal" del /f /q "%ROOT%backend\data\photo-local.sqlite-wal"

if exist "%ROOT%backend\data\photo-local.sqlite" goto db_delete_failed
if exist "%ROOT%backend\data\photo-local.sqlite-shm" goto db_delete_failed
if exist "%ROOT%backend\data\photo-local.sqlite-wal" goto db_delete_failed
echo [OK] Baza danych usunieta.
goto db_delete_done

:db_delete_failed
echo [BLAD] Nie udalo sie usunac wszystkich plikow bazy. Wylacz serwer Photo Local i sprobuj ponownie.

:db_delete_done

if exist "%ROOT%backend\data\google-chat-browser-profile" echo [OK] Profil Google Chat zostawiony: backend/data/google-chat-browser-profile

echo.
echo Usuwanie zdjec z backendu...
if exist "%ROOT%backend\photos" rmdir /s /q "%ROOT%backend\photos"
if exist "%ROOT%backend\photos" echo [BLAD] Nie udalo sie usunac folderu backend/photos!
if not exist "%ROOT%backend\photos" echo [OK] Folder ze zdjeciami usuniety.

echo.
echo Srodowisko zresetowane! Mozesz znow uruchomic serwer.
pause
exit /b

:abort
echo Przerwano operacje.
pause
exit /b
