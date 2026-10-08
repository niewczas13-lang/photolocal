# Zaproszenia Google Chat i logowanie w Romku

Romka ma osobną przeglądarkę do obsługi zaproszeń Google Chat. Jej okno otwierasz w aplikacji, bez pulpitu zdalnego serwera. Profil przeglądarki zachowuje logowanie między restartami kontenera. Google nadal może poprosić o ponowne zalogowanie lub potwierdzenie tożsamości.

Logowanie przeglądarki służy zaproszeniom. Pobieranie zdjęć używa dotychczasowego połączenia OAuth. W obu miejscach wybierz to samo konto Google, aby zaakceptowane pokoje były dostępne do pobierania.

## Aktualizacja serwera Windows

Uruchom PowerShell na koncie Windows, na którym działa Docker Desktop i które przygotowało produkcyjne katalogi Romka. Poczekaj na zakończenie importów i pobierania oraz przerwij pracę użytkowników na czas przełączenia aplikacji. Budowanie obrazów odbywa się, gdy dotychczasowa aplikacja nadal działa; samo przełączenie powoduje krótką przerwę.

Jeżeli `scripts\update-chat-browser.ps1` nie ma jeszcze w `C:\PhotoLocal-staging`, najpierw pobierz aktualizację repozytorium: `git -C C:\PhotoLocal-staging pull --ff-only`. Przy kolejnych wywołaniach skrypt sam wykonuje `git pull --ff-only`.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File C:\PhotoLocal-staging\scripts\update-chat-browser.ps1 -WorkStopped
```

Domyślny katalog tej instalacji to `C:\PhotoLocal-staging\docker-data\production-938460e57d394e1bbe0c1371e4dd391e`. Dla innej przygotowanej instalacji podaj `-RunDirectory` z jej pełną ścieżką. Skrypt sprawdza bieżący kontener i odczytuje jego pliki Compose w używanej kolejności, więc zachowuje także wcześniejsze poprawki konfiguracji.

Skrypt buduje oba obrazy, uruchamia i sprawdza przeglądarkę, a następnie odtwarza wyłącznie kontener aplikacji. Baza, pobrane zdjęcia, zdjęcia lokalne, token OAuth i udział NAS zachowują obecne lokalizacje. Wynik `CHAT_BROWSER_UPDATED` potwierdza sprawdzenie uruchomionych kontenerów. Logowanie Google trzeba następnie sprawdzić w aplikacji.

Opcja `-PrepareOnly` buduje obrazy i sprawdza przeglądarkę bez przełączania aplikacji. Późniejsze zwykłe wywołanie z `-WorkStopped` powtarza kontrolę, korzystając z pamięci podręcznej budowania i tego samego profilu. Jeśli przeglądarka była już wcześniej używana, jej aktualizacja może zamknąć aktualnie otwarte okno logowania.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File C:\PhotoLocal-staging\scripts\update-chat-browser.ps1 -PrepareOnly
```

Przeglądarka działa jako użytkownik `1000:1000`, bez portów na hoście, z systemem plików tylko do odczytu i własnym wolumenem profilu `photolocal-production-chat-browser-profile`. Nie ma dostępu do bazy, tokenów OAuth ani zdjęć. Nie usuwaj tego wolumenu podczas zwykłej aktualizacji i nie uruchamiaj `docker compose down -v`.

Sandbox Chromium jest domyślnie włączony. Skrypt nie wyłącza go automatycznie po błędzie. Jeśli uruchomienie zakończy się `CHAT_BROWSER_UPDATE_BROWSER_START_FAILED`, aplikacja pozostaje na dotychczasowym obrazie. Dopiero po ustaleniu, że przyczyną jest niedostępny sandbox, i sprawdzeniu izolacji kontenera można jawnie dodać `-DisableSandbox`; oznacza to pracę Chromium bez jego sandboxa.

## Przywrócenie poprzedniego obrazu

Przed przełączeniem aplikacji skrypt zapisuje w prywatnym katalogu instalacji plik `chat-browser-rollback-<identyfikator>.json`. Jego ścieżka jest zwracana jako `rollbackReport`, również gdy start nowego kontenera się nie powiedzie. Raport zawiera identyfikatory obrazów, ścieżki i skróty poprzednich plików konfiguracji; nie zawiera tokenów ani haseł.

Jeśli wynik wskazuje `applicationMayHaveChanged: true`, poprzedni kontener mógł zostać zastąpiony. Aby jawnie przywrócić poprzedni obraz, użyj ścieżki z wyniku:

```powershell
$romekRollbackReport = 'C:\PhotoLocal-staging\docker-data\production-938460e57d394e1bbe0c1371e4dd391e\chat-browser-rollback-WSTAW_IDENTYFIKATOR_Z_WYNIKU.json'
powershell -NoProfile -ExecutionPolicy Bypass -File C:\PhotoLocal-staging\scripts\update-chat-browser.ps1 -WorkStopped -RollbackReport $romekRollbackReport
```

Przywrócenie działa także dla zatrzymanej lub niezdrowej aplikacji, sprawdza tożsamość kontenera i skróty konfiguracji, a następnie uruchamia poprzedni obraz na **obecnych danych**. Nie cofa zdjęć ani zmian w bazie. Nie pobiera kodu, nie buduje obrazów i nie usuwa przeglądarki ani jej profilu. Wynik `CHAT_BROWSER_ROLLED_BACK` oznacza, że poprzedni obraz przeszedł kontrolę zdrowia.

## Logowanie i zaproszenia

1. Otwórz zlecenie i panel **Import Chat**.
2. W sekcji **Zaproszenia do pokojów** wybierz **Zaloguj Google w Romku**.
3. W oknie **Logowanie Google do zaproszeń** zaloguj się na konto używane do pobierania zdjęć. Potwierdzenia Google wykonaj samodzielnie w tym oknie.
4. Wybierz **Zamknij okno logowania**, a następnie **Znajdź zaproszenia**.
5. Przy wybranym zaproszeniu kliknij **Akceptuj**. Lista dostępnych pokojów odświeża się po potwierdzonym przyjęciu zaproszenia.

Jeśli okno przeglądarki nie łączy się, sprawdź obsługę przekazywania połączeń WebSocket w proxy udostępniającym Romka. Porty VNC i CDP mają pozostać wewnętrzne; ich publikowanie na hoście nie jest wymagane.

## Zmiana Photos na NAS podczas tworzenia zlecenia

Przycisk **W gore** w głównym folderze Photos lub NAS wraca do listy lokalizacji. Możesz wtedy wybrać drugi dysk i utworzyć folder zdjęć. Wybrany plik oraz pozostałe ustawienia formularza zostają zachowane. W podfolderach ten sam przycisk przechodzi do folderu nadrzędnego.

Weryfikacja lokalna obejmuje logikę aktualizacji i przywracania, rzeczywiste scalanie Compose bez silnika Docker oraz wykonanie koordynatora w PowerShell 5 z atrapami poleceń. Obraz przeglądarki i rzeczywiste logowanie Google wymagają sprawdzenia na serwerze z działającym silnikiem Linux Docker.
