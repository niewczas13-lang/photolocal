@echo off
set "ROOT=%~dp0"

echo =======================================================
echo  UWAGA: Ten skrypt usunie CALA baze danych i WSZYSTKIE 
echo  wgrane zdjecia! (Szuka w gtownym folderze i backendzie)
echo =======================================================
echo.
set /p CHOICE="Wpisz T aby potwierdzic usuniecie: "
if /I not "%CHOICE%"=="T" goto abort

echo.
echo Usuwanie starych folderow w root (jesli istnieja)...
if exist "%ROOT%data" rmdir /s /q "%ROOT%data"
if exist "%ROOT%photos" rmdir /s /q "%ROOT%photos"

echo Usuwanie wlasciwej bazy danych z backendu...
if exist "%ROOT%backend\data" rmdir /s /q "%ROOT%backend\data"
if exist "%ROOT%backend\data" echo [BLAD] Nie udalo sie usunac folderu backend/data! (Wylacz npm run dev przed uruchomieniem).
if not exist "%ROOT%backend\data" echo [OK] Baza danych usunieta.

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
