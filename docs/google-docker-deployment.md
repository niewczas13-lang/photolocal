# Google i Docker — wdrożenie istniejącego PhotoLocal

Zmiany można wdrożyć najpierw na Windows, a Docker uruchomić równolegle na kopii danych.
Przełączenie produkcji wymaga krótkiej przerwy na końcową, spójną kopię. Nie należy
uruchamiać dwóch instancji zapisujących do tej samej bazy, zdjęć ani tokenu Google.

## 1. Ustalenie obecnego stanu na serwerze

W PowerShell, przez pulpit zdalny:

```powershell
Set-Location C:\PhotoLocal
git status --short
git rev-parse HEAD
docker info --format '{{.OSType}}'
Get-NetTCPConnection -State Listen -LocalPort 4873 | Select-Object LocalAddress, OwningProcess
```

Zapisz identyfikator wersji i sprawdź lokalnie `.env`: faktyczne położenie bazy,
pobranych zdjęć, tokenu i pliku klienta Google. Nie wklejaj sekretów do zgłoszeń lub GitHuba.
Sprawdź katalogi projektów w aplikacji, dostępność udziałów sieciowych i adres Ollamy.
Ścieżki względne bazy zależą od katalogu roboczego procesu — obecny `start.bat` uruchamia
backend z katalogu `backend`. Przed migracją ustal pełne ścieżki istniejących danych.

Do obrazu potrzebny jest silnik **Linux containers**. Samo zainstalowanie Docker Desktop
nie oznacza, że silnik działa. Przy wielu udostępnionych dyskach trzeba odwzorować każdy
używany katalog; litery dysków sesji RDP nie pojawiają się automatycznie w kontenerze.

## 2. Jednorazowa konfiguracja logowania Google

Właściciel projektu Google Cloud:

1. Włącza Google Chat API w odpowiednim projekcie. Konfiguruje ekran zgody i dostęp dla
   konta, które już ma dostęp do pobieranych czatów.
2. Tworzy klienta OAuth typu **Web application**. JSON z kluczem `installed` jest klientem
   desktopowym; nowe logowanie przez Romka wymaga JSON z kluczem `web`.
3. Rejestruje dokładny adres **Authorized redirect URI**:
   `https://romek.pawelzykubek.pl/api/google-chat/auth/callback`.
4. Zapisuje pobrany JSON w prywatnym katalogu na serwerze i ustawia
   `GOOGLE_CHAT_CREDENTIALS_FILE` oraz powyższy `GOOGLE_CHAT_OAUTH_REDIRECT_URI` w `.env`.
   Istniejący token zostaje zachowany do udanego połączenia. Zrób jego prywatną kopię
   razem z dotychczasowym plikiem klienta przed pierwszą zmianą.
5. Po uruchomieniu nowej wersji loguje się do Romka, otwiera import Google Chat,
   wybiera **Połącz Google**, właściwe konto i przyznaje oba uprawnienia odczytu:
   `chat.spaces.readonly` i `chat.messages.readonly`.
6. Sprawdza połączenie, listę czatów i pobranie małej paczki. Logowanie odbywa się
   w przeglądarce osoby obsługującej Romka. Token trafia wyłącznie na serwer.

Adres powrotu musi prowadzić do tej samej instancji, która rozpoczęła logowanie.
Nie używaj produkcyjnego callbacku do testowania kontenera na innym porcie.
Do testu w przeglądarce **na serwerze** można osobno zarejestrować
`http://localhost:4874/api/google-chat/auth/callback` i otworzyć Romka przez
`http://localhost:4874`. Do testu z innego komputera użyj osobnej domeny HTTPS
kierującej do stagingu. Logowanie wymaga zachowania sesji Romka w tej przeglądarce.
Restart backendu w czasie logowania wymaga rozpoczęcia połączenia od nowa.

Google przyznaje dostęp offline, a downloader odświeża wygasły token dostępu.
Dla aplikacji zewnętrznej w stanie **Testing** odświeżanie z tymi zakresami wygasa
po 7 dniach. Sprawdź stan publikacji i wymagania Google; przejście do Production
nie gwarantuje niewygasającej zgody. Cofnięcie dostępu lub zasady administratora
nadal mogą wymagać ponownego połączenia.
Źródła: [OAuth Google](https://developers.google.com/identity/protocols/oauth2),
[logowanie aplikacji webowej](https://developers.google.com/identity/protocols/oauth2/web-server).

**Zaproszenia:** uprawnienia API i sesja przeglądarki Google Chat są osobne. Na Windows
dotychczasowa automatyzacja zaproszeń pozostaje dostępna. W kontenerze przycisk otwiera
zwykły Google Chat na komputerze użytkownika. Zaakceptuj zaproszenie na **tym samym
koncie**, które połączono z Romkiem, a potem odśwież listę czatów. Kontener nie zawiera
zdalnego pulpitu ani automatyzacji przeglądarki Windows.

**Starsza metoda:** jawne `python pobierzchat/chat.py --login` pozostaje dostępne
dla konfiguracji desktopowej. Zwykłe pobieranie i listowanie nigdy same nie otwierają
okna logowania. Po ręcznej wymianie tokenu użyj **Sprawdź połączenie** w aplikacji.

## 3. Przygotowanie kodu bez zatrzymywania obecnej aplikacji

Zbuduj zatwierdzoną wersję w osobnym katalogu, np. `C:\PhotoLocal-staging`.
Do próby tej gałęzi można pobrać osobny checkout (katalog docelowy musi być nowy):

```powershell
git clone --branch codex/google-auth-docker --single-branch https://github.com/niewczas13-lang/photolocal.git C:\PhotoLocal-staging
```

Przy testowaniu wariantu Windows potrzebne są Node.js 24 oraz Python 3.11 lub nowszy.
Zainstaluj zależności i zbuduj kod w tym nowym katalogu:

```powershell
Set-Location C:\PhotoLocal-staging
npm ci
npm run build
python -m pip install -r pobierzchat/requirements.txt
```

Na etapie Windows ustaw pełne, osobne ścieżki danych testowych oraz inny port w `.env`.
Sprawdź działanie nowej wersji przed zatrzymaniem starego procesu. Nie podmieniaj
pliku `.env` przykładową konfiguracją i nie kieruj nowego procesu na produkcyjną bazę
w czasie równoległego testu. Istniejący `update.bat` nie zastępuje procedury wykonania
spójnej kopii i przygotowania wersji przed przerwą.

## 4. Pusty kontener testowy

W nowym katalogu stagingu, przed kopiowaniem danych:

```powershell
Copy-Item .env.docker.example .env.docker
New-Item -ItemType Directory -Path docker-data/data,docker-data/google,docker-data/downloads,docker-data/photos
docker compose --env-file .env.docker config --quiet
docker compose --env-file .env.docker build
docker compose --env-file .env.docker up -d --wait
Invoke-RestMethod http://localhost:4874/health
```

Domyślnie port 4874 jest dostępny tylko lokalnie. Nowa pusta baza tworzy standardowe
konta aplikacji z domyślnymi hasłami; zmień je przed jakimkolwiek publicznym udostępnieniem.
Docelowo użyj zmigrowanej kopii istniejącej bazy, zachowującej jej konta i dane.
Do zmiany hasła w działającym kontenerze służy istniejące narzędzie
`docker compose --env-file .env.docker exec photolocal node backend/dist/auth/add-user-cli.js`;
sprawdź jego wymagane argumenty w instrukcji zarządzania kontami repozytorium.

Obraz działa jako UID/GID 1000. Na Linuksie nadaj temu użytkownikowi prawa do **nowych
katalogów stagingu**; same prawa do folderu nadrzędnego nie wystarczą dla plików
skopiowanych z prawami 0600. Na Windows sprawdź możliwość zapisu przez Docker Desktop.

Trwałe katalogi:

| Katalog kontenera | Zawartość |
| --- | --- |
| `/data` | SQLite, WAL/SHM, stan pobierania, logi |
| `/google` | `credentials.json`, `token.json`, blokada tokenu |
| `/downloads` | pobrane zdjęcia, manifesty, `.receipts`, `.spaces.json` |
| `/photos` | pełne katalogi projektów ze zdjęciami i miniaturami |

Montowane są całe katalogi: atomowa wymiana tokenu i pliki pomocnicze SQLite wymagają
zapisywalnego katalogu. W `.env.docker` używaj ścieżek Windows z `/`, np.
`C:/PhotoLocal-staging/docker-data/data`. Tokenów nie umieszczaj w obrazie ani repozytorium.
Skonfiguruj również `OLLAMA_URL`; domyślnie kontener łączy się z hostem przez
`http://host.docker.internal:11434`. Sprawdź dostęp i wybrany model przed klasyfikacją.

Obraz domyślnie używa `TZ=Europe/Warsaw`, aby zachować interpretację zdjęć, których
EXIF nie podaje strefy czasowej, tak jak na dotychczasowym serwerze. Jawny offset
zapisany w EXIF ma pierwszeństwo. Dla instalacji w innej strefie ustaw `TZ` w sekcji
`environment` usługi. Obraz zawiera też czcionki potrzebne do napisów na zdjęciach.

## 5. Kopia danych i mapowanie ścieżek

Zaczekaj na koniec pobierania, importowania, klasyfikacji i zapisu zdjęć. Wstrzymaj
pracę użytkowników, zatrzymaj właściwy proces aplikacji oraz ewentualny osobny downloader.
Sprawdź brak procesów zapisujących do tych danych. Wtedy wykonaj prywatną kopię całej
bazy **wraz z istniejącymi plikami `-wal`, `-shm`, `-journal`**, pasujących zdjęć,
miniatur, katalogu pobrań z plikami ukrytymi i konfiguracji Google. Wszystkie elementy
muszą pochodzić z tego samego momentu bez zapisów. Nie kopiuj wyłącznie aktywnego pliku
SQLite. Zachowaj tę kopię poza katalogiem wdrożenia.

Do próbnej migracji można uruchomić starą aplikację ponownie po wykonaniu spójnej kopii.
Końcowe przełączenie wymaga później **nowej** kopii, obejmującej nowszą pracę.

Migrator przepisuje wyłącznie kopię bazy; nie kopiuje i nie sprawdza istnienia zdjęć.
Mapę przygotuj według rzeczywistych ścieżek w bazie. Przykład `mapping.json`:

```json
[
  {"from":"P:\\Projekty","to":"/photos"},
  {"from":"C:\\PhotoLocal\\pobierzchat\\pobrane_zdjecia","to":"/downloads"}
]
```

Zawartość `P:\Projekty` musi trafić do katalogu montowanego jako `/photos`, z zachowaniem
podkatalogów. Przy wielu udziałach dodaj osobne mounty i rozłączne prefiksy docelowe,
np. `/photos-a`, `/photos-b`, oraz ustaw je w `PHOTO_LOCAL_SHARED_ROOTS`. Nieznane
bezwzględne ścieżki powodują przerwanie migracji. Migracja dotyczy ośmiu kolumn ścieżek;
logiczne ścieżki checklisty pozostają bez zmian. Różnice wielkości liter nazw plików
Windows/Linux wymagają sprawdzenia na rzeczywistym zestawie zdjęć.

Zatrzymaj testowy kontener. Wskaż **nieistniejący plik wynikowy** w istniejącym pustym
katalogu, np. nowym `docker-data/migrated-data`:

```powershell
docker compose --env-file .env.docker stop
New-Item -ItemType Directory -Path docker-data/migrated-data
node scripts/migrate-docker-data.mjs --source C:/PhotoLocal-backup/photo-local.sqlite --output ./docker-data/migrated-data/photo-local.sqlite --mapping ./mapping.json
```

Narzędzie nie otwiera oryginału przez SQLite: weryfikuje prywatną kopię bazy/WAL,
tworzy backup, przepisuje ścieżki transakcyjnie i sprawdza `integrity_check`. Obok
powstaje raport `*.migration.json`. Potrzebne jest miejsce na kopię roboczą i wynik
oraz system plików obsługujący hardlinki, np. NTFS/ext4. Pliki źródłowe muszą pozostawać
niezmienione przez cały czas. Błąd migracji oznacza brak zgody na przełączenie danych.

Ustaw `PHOTO_LOCAL_DATA_DIR=./docker-data/migrated-data`, przygotuj odpowiadające mu
kopie zdjęć/pobrań i konfigurację Google. Istniejący `google-chat-download.json`
można skopiować razem z danymi; zadanie RUNNING wraca jako PAUSED. Ścieżka pobierania
jest ustalana ponownie z `.spaces.json` po zmianie systemu. Zachowaj cały katalog
pobrań, aby wznowienie korzystało z manifestów i zweryfikowanych plików.

Po ustawieniu nowych mountów uruchom kontener ponownie przez `up`, które zastosuje
zmiany konfiguracji (samo `restart` tego nie robi):

```powershell
docker compose --env-file .env.docker up -d --wait
Invoke-RestMethod http://localhost:4874/health
```

## 6. Sprawdzenie i przełączenie

Przed zmianą publicznego adresu sprawdź na kopii: konta, liczbę projektów/zdjęć,
otwieranie miniatur i oryginałów z różnych projektów, pobranie istniejącej paczki
bez duplikacji, wznowienie po restarcie kontenera, import i klasyfikację Qwen.
Wymuszone wygaśnięcie Google ma pokazać prośbę o połączenie i zachować już pobrane pliki.
Weryfikację utraty dostępu wykonuj na koncie testowym, bez cofania zgody produkcyjnej.

Po udanym teście wykonaj końcową spójną kopię przy wstrzymanych zapisach, powtórz
migrację do nowego katalogu i sprawdź dane. Dopiero wtedy skieruj istniejący reverse
proxy na port kontenera. Jeśli proxy jest innym kontenerem, `127.0.0.1` oznacza jego
własny kontener — użyj uzgodnionej sieci Dockera/nazwy usługi lub dostępnego adresu
hosta. Publiczny callback Google musi już prowadzić do nowej instancji.

`restart: unless-stopped` uruchamia kontener po powrocie silnika Docker, chyba że
został ręcznie zatrzymany. Sprawdź **restart całego serwera bez logowania przez RDP**
w uzgodnionym oknie, bo dotyczy też pozostałych usług. Docker Desktop ma opcję startu
przy logowaniu użytkownika; to nie stanowi gwarancji startu przed logowaniem.
Jeśli obecny host tego nie zapewnia, trzeba najpierw ustalić sposób startu silnika
lub użyć uruchamianej z systemem maszyny Linux z Docker Engine.
Źródła: [ustawienia Desktop](https://docs.docker.com/desktop/settings-and-maintenance/settings/),
[reguły restartu](https://docs.docker.com/engine/containers/start-containers-automatically/).

Powrót przed nowymi zapisami: zatrzymaj nową instancję, przywróć kierowanie ruchu
na starą i uruchom ją z zachowanymi danymi oraz konfiguracją. Po rozpoczęciu pracy
na nowej wersji nie wracaj po prostu do starej bazy: najpierw zachowaj nową bazę
i pliki, potem uzgodnij przeniesienie zmian. Raport mapowania pomaga ustalić ścieżki,
ale nie jest automatyczną migracją powrotną i nie scala nowszych danych.
