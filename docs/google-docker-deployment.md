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

## Diagnostyka udziału SMB z Windows

Jeżeli Windows czyta udział, lecz Docker odrzuca jego ścieżkę UNC jako bind mount,
można wykonać jedną izolowaną próbę odczytu przez wolumen CIFS. W katalogu staging,
z zainstalowanym Node.js i istniejącym obrazem `photolocal:staging`, uruchom:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-smb-access.ps1 -Server fileserver.example -Share Photos -Subdirectory Projects -UserName 'EXAMPLE-PC\photo-user'
```

Podaj rzeczywisty serwer, udział, podkatalog i konto. Hasło wpisuje się wyłącznie
w lokalnym oknie `Get-Credential`. Skrypt przekazuje je przez stdin do Node i Docker
Compose; nie zapisuje konfiguracji na dysku ani nie umieszcza hasła w argumentach
procesu. Docker przechowuje jednak opcje CIFS w metadanych testowego wolumenu do jego
usunięcia; administrator silnika ma do nich dostęp. Nie udostępniaj inspekcji wolumenu,
`compose config` ani surowych logów montowania.

Próba używa SMB 3.1.1 i użytkownika UID/GID 1000. Wolumen i kontener są tylko do
odczytu, kontener nie ma sieci ani portów, a kopiowanie zawartości obrazu do wolumenu
jest wyłączone. Test tylko odczytuje katalog; nie potwierdza jeszcze dostępu do
wszystkich zdjęć, możliwości zapisu ani autostartu. Nie wymaga zatrzymania aplikacji.

Raport `Status: DIRECTORY_READ_OK` i `Cleanup: CLEAN` potwierdza odczyt i zakończenie
sprzątania. `MOUNT_ACCESS_DENIED` oznacza odmowę przed odczytem katalogu (np.
uwierzytelnienie, uprawnienia udziału lub zasady SMB), a `DIRECTORY_ACCESS_DENIED`
odmowę odczytu w uruchomionym kontenerze. Żaden z tych kodów samodzielnie nie
potwierdza błędnego hasła. `Cleanup: REQUIRED` wymaga sprawdzenia zasobów nazwanych w `ProbeId`
(wolumen ma dodatkowo końcówkę `-remote`); po timeoutach silnik może jeszcze kończyć
montowanie. Skrypt usuwa wyłącznie zasoby tej próby. Nigdy nie wykonuje `prune`.
`CREDENTIAL_FORMAT_UNSUPPORTED` oznacza, że nie wykonano logowania: przecinek,
NUL lub znak nowej linii w danych konta wymagają innej konfiguracji montowania.
Nie zmieniaj hasła w celu obejścia tego ograniczenia.

Po udanym odczycie katalogu można dodać `-CheckFilesAndWrite` do tego samego polecenia.
Ten jawny wariant montuje udział do zapisu, odczytuje do 64 KiB jednego istniejącego
zdjęcia i wykonuje zapis, odczyt, zmianę nazwy oraz usunięcie pliku wyłącznie w nowym
katalogu `.<ProbeId>` pod wybranym podkatalogiem udziału. Istniejące zdjęcia są tylko
odczytywane. Folder testowy jest tworzony wyłącznie, gdy jeszcze nie istnieje;
sprzątanie nie usuwa rekurencyjnie katalogów. Sukces ma kod `STORAGE_READ_WRITE_OK`.
`TEST_FOLDER_CLEANUP_REQUIRED` wymaga sprawdzenia pozostawionego katalogu próbnego.
Wyszukiwanie zdjęcia ma limit 500 katalogów i 10 000 wpisów; `PHOTO_SAMPLE_NOT_FOUND`
nie oznacza, że na całym udziale nie ma zdjęć. Ten test nie zastępuje sprawdzenia
ścieżek i oryginałów w poszczególnych projektach po migracji kopii bazy.

Przy stagingu z istniejącym NAS nie trzeba kopiować całego udziału na dysk Windows.
Można podłączyć go tylko do odczytu w `/nas` i odwzorować np. `P:\Projekty` na
`/nas/Projekty`, jeżeli korzeń `P:` odpowiada korzeniowi montowanego udziału.
Próby importu i edycji wykonuj w osobnym projekcie i katalogu testowym.

### Trwały udział i kopia bazy działającego Windowsa

Po udanym `STORAGE_READ_WRITE_OK` helper `scripts/connect-staging-storage.ps1`
tworzy osobny wolumen CIFS tylko do odczytu. Przyjmuje te same parametry serwera,
udziału, podkatalogu i konta oraz `-OutputDirectory <staging>\docker-data`.
Hasło wpisujesz lokalnie; pozostaje w metadanych wolumenu Dockera potrzebnych do
ponownego montowania. Plik `docker-data/storage.json` zawiera tylko nazwę wolumenu,
punkt montowania i podkatalog. Sukces: `STAGING_STORAGE_READY`, `Cleanup: CLEAN`.
Istniejący manifest zatrzymuje kolejną próbę przed pytaniem o hasło.

Następnie na serwerze Windows uruchom (dostosuj trzy ścieżki):

```powershell
node C:\PhotoLocal-staging\scripts\prepare-staging-copy.mjs --production-root C:\PhotoLocal --staging-root C:\PhotoLocal-staging --network-prefix 'P:\Projekty' --start
```

`--network-prefix` wskazuje prefiks w starej bazie odpowiadający podkatalogowi
z manifestu SMB. Cały udział jest zamontowany w `/nas`, np. `P:\Projekty`
odpowiada `/nas/Projekty`. Helper zakłada standardowe katalogi lokalnych zdjęć
`backend/zdjęcia` i pobrań `pobierzchat/pobrane_zdjecia` pod katalogiem produkcji.

Proces najpierw sprawdza Compose i katalogi. Potem natywne `better-sqlite3` ze starego
backendu wykonuje kopię online do nowego `docker-data/migration-*`. Zatwierdzone
rekordy z WAL są uwzględniane przez API SQLite; nie kopiujemy ręcznie aktywnego pliku.
Źródłowa aplikacja może nadal zapisywać. Limit 60 sekund działa między krokami
backupu i nie przerywa blokującego wywołania systemowego. Brak natywnej zależności,
brak wolnego miejsca lub przekroczenie limitu kończy przygotowanie przed startem.

Kontener migracji otrzymuje wyłącznie ukończoną kopię bazy. Zdjęcia z NAS oraz stare
lokalne zdjęcia i pobrania są potem montowane tylko do odczytu. Audyt sprawdza liczby
rekordów, każdy folder projektu i do trzech oryginalnych zdjęć na projekt. Nowe
pobrania, testowe projekty i pliki Google pozostają w dotychczasowych katalogach
stagingu. `--start` odtwarza wyłącznie usługę `photolocal-staging` na
`127.0.0.1:4874`, bez budowania obrazu, i czeka na zdrowy kontener.

Sukces przygotowania: `STAGING_COPY_READY`; z `--start`: `STAGING_COPY_RUNNING`.
`docker-data/staging-copy.json` zapisuje ścieżkę dodatkowego pliku Compose i wyniki.
Dotychczasowa testowa baza nie jest nadpisywana. Użytkownicy i hasła aplikacji
pochodzą z kopii produkcyjnej bazy. Na tym etapie edycję i pobieranie do istniejących
projektów ogranicza montowanie NAS tylko do odczytu; próby zapisu wykonuj w osobnym
projekcie z plikiem GPKG i folderem `/photos`.

Przy błędzie raport podaje katalog konkretnej próby. `audit.json` rozróżnia brak
plików od nieprawidłowej bazy, a `container-migrate.json` i `container-audit.json`
zawierają nazwy własnych kontenerów potrzebne do celowanego sprzątania. Nie usuwaj
produkcji ani nie nadpisuj manifestów w celu ponowienia — sprawdź przyczynę.
Kopie bazy zawierają prywatne dane, hasła aplikacji w postaci skrótów i sesje;
pozostają w ignorowanym przez Git `docker-data`.

Przy późniejszym uruchamianiu zachowaj oba pliki Compose:

```powershell
$stagingCopy = Get-Content -Raw -LiteralPath C:\PhotoLocal-staging\docker-data\staging-copy.json | ConvertFrom-Json
docker compose -p photolocal-staging --project-directory C:\PhotoLocal-staging --env-file C:\PhotoLocal-staging\.env.docker -f C:\PhotoLocal-staging\compose.yaml -f $stagingCopy.composeFile up -d --no-build --pull never --wait photolocal
```

Powrót do wcześniejszej pustej bazy stagingu polega na uruchomieniu tej samej komendy
bez drugiego `-f $stagingCopy.composeFile`. Publiczna produkcja pozostaje osobną
aplikacją. Baza stanowi spójną migawkę z czasu backupu; zdalne zdjęcia mogą w tym czasie
zmieniać się w produkcji. Końcowe przełączenie wymaga świeżej kopii i uzgodnionego
momentu zatrzymania zapisów oraz osobnego sprawdzenia autostartu po restarcie Windowsa.

Gdy raport wskazuje `STAGING_COPY_FILES_MISSING`, sprawdź istniejącą próbę poleceniem
`node scripts/diagnose-staging-copy.mjs --run-directory <katalog-próby> --windows-share <UNC-udziału>`.
Nie powstaje nowa kopia bazy ani konfiguracja udziału. Helper ponawia audyt tylko do
odczytu z `--details` i porównuje nieudane ścieżki z ich odpowiednikami Windows.
Prefiks dysku sieciowego zastępuje podanym UNC; używa bieżących poświadczeń sesji
Windows, które mogą różnić się od konta zapisanego w wolumenie Dockera.

Stałe przyczyny rozróżniają m.in. `ENOENT`, `EACCES`, `EMPTY_FILE`, `OUTSIDE_ROOT`
i `MOUNT_UNAVAILABLE`. Maksymalnie 50 szczegółów oraz wyniki porównania trafiają do
nowego `diagnosis-*.json` w katalogu próby. Konsola grupuje je według projektu
i przyczyn, pokazując przykładowe ścieżki; raporty zawierają prywatne nazwy folderów
i zdjęć, ale nie dane logowania. Natywny odczyt Windows ma osobny limit 60 sekund;
przekroczenie daje `WINDOWS_CHECK_TIMEOUT`, a nie informację o braku plików.

Jeśli bieżąca sesja Windows nie widzi nawet katalogów kontrolnych dostępnych
w Dockerze, jej błędy nie potwierdzają braku plików. Użyj
`node scripts/diagnose-staging-copy.mjs --run-directory <katalog-próby> --locate`.
Ten wariant korzysta wyłącznie z zachowanego wolumenu CIFS. Dla nieudanych ścieżek
pokazuje najgłębszy dostępny katalog, pierwszy brakujący segment oraz rzeczywiste
podobne nazwy. Rozpoznaje podobieństwa wielkości liter, polskich znaków i odstępów;
sugestie nie są automatycznie stosowane. Sprawdza maksymalnie 64 segmenty ścieżki,
2000 wpisów katalogu i 12 podobnych nazw, bez rekurencyjnego przeszukiwania udziału.
Raport zachowuje pełne liczniki, a szczegóły ogranicza do 48 KiB.

### Podgląd istniejącej kopii z raportem braków

Do obejrzenia projektów i dostępnych zdjęć można uruchomić osobny tryb podglądu:
`node scripts/start-staging-preview.mjs --run-directory <katalog-próby>`.
Nie wykonuje kolejnego backupu ani napraw ścieżek. Sprawdza świeży audyt przez
Docker, zgodność wszystkich pięciu liczników z zapisaną migawką oraz scaloną
konfigurację Compose. Wymaga uwierzytelniania, portu `127.0.0.1:4874`, osobnej bazy
stagingu i montowania NAS oraz starych plików lokalnych tylko do odczytu.

`STAGING_PREVIEW_RUNNING` oznacza uruchomiony podgląd, także wtedy, gdy część
folderów lub próbek zdjęć jest niedostępna. Raport zawiera te braki i lokalizacje
rozbieżności; nie jest potwierdzeniem pełnej dostępności zdjęć ani gotowości
produkcji. Samo sprawdzenie obejmuje próbki, a nie każdy plik z bazy. Baza podglądu
pozostaje zapisywalna dla działania aplikacji, a produkcyjne pliki są tylko do
odczytu. Zapisana konfiguracja podglądu jest oddzielona od manifestu pełnej migracji.
Ponowienie wymaga tej samej kopii i nadal zgodnych liczników; dodanie w podglądzie
nowych projektów lub zdjęć zmieni liczniki i wymaga osobnej decyzji o dalszej pracy.

Podstawa kopii online: [SQLite Online Backup API](https://www.sqlite.org/backup.html)
i [better-sqlite3 backup](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md#backupdestination-options---promise).
Przy scalaniu plików Compose [montowania są łączone według punktu docelowego](https://docs.docker.com/reference/compose-file/merge/#unique-resources),
a [wolumen external](https://docs.docker.com/reference/compose-file/volumes/#external)
pozostaje zarządzany osobno.

Źródła: [wolumen CIFS](https://docs.docker.com/engine/storage/volumes/#create-cifssamba-volumes),
[Compose ze stdin](https://docs.docker.com/reference/cli/docker/compose/),
[interpolacja Compose](https://docs.docker.com/reference/compose-file/interpolation/).

### Windows: automatyczne logowanie i blokada konsoli

Docker Desktop ma opcję startu po zalogowaniu użytkownika. Automatyczne logowanie
tego samego konta Windows pozwala uruchomić istniejącą konfigurację Dockera po
starcie komputera bez ręcznego wejścia przez RDP. Wymagany jest włączony start
Dockera przy logowaniu; sam helper tego ustawienia nie zmienia.
[Ustawienia Docker Desktop](https://docs.docker.com/desktop/settings-and-maintenance/settings/#general).

Na serwerze otwórz **64-bitowy Windows PowerShell jako administrator**, na tym samym
koncie Windows, które obecnie uruchamia Docker Desktop. Wykonaj:

```powershell
git -C C:\PhotoLocal-staging pull --ff-only
if ($LASTEXITCODE -eq 0) {
    powershell -NoProfile -ExecutionPolicy Bypass -File C:\PhotoLocal-staging\scripts\prepare-windows-autologon.ps1
}
```

Helper sprawdza właściciela procesów Dockera i wpis startu przy logowaniu, pobiera
oficjalny Microsoft Autologon oraz weryfikuje podpis Microsoft. W jego oknie sprawdź
`User` i `Domain` względem konta wypisanego w PowerShell, wpisz **hasło Windows**
(nie PIN, hasło Google ani SMB), kliknij **Enable**, a po komunikacie zamknij okno.
Hasło wpisuje się wyłącznie w narzędziu Microsoft. Windows przechowuje je jako
sekret LSA; administrator komputera może je odzyskać. Narzędzie Autologon nie
sprawdza poprawności wpisanego hasła.
[Microsoft Autologon](https://learn.microsoft.com/en-us/sysinternals/downloads/autologon).

Przed otwarciem tego okna helper tworzy zadanie `PhotoLocal Docker Console Lock`,
ograniczone do tego konta i zwykłych uprawnień. Przy logowaniu żąda blokady wyłącznie
w sesji fizycznej konsoli; sesje RDP pomija. Próby są ograniczone do 15 sprawdzeń
z dwusekundowymi przerwami. Istniejące zadanie o zgodnej konfiguracji jest zachowane
przy ponowieniu; inna konfiguracja pod tą nazwą daje `LOCK_TASK_CONFLICT` i nie jest
nadpisywana. Zachowaj katalog stagingu i znajdujący się w nim skrypt blokady.

`AUTOLOGON_CONFIGURED_REBOOT_NOT_TESTED` potwierdza zapis flagi automatycznego
logowania właściwego konta i konfigurację zadania. Nie potwierdza hasła, startu
Dockera po restarcie ani faktycznej blokady ekranu. Również `LOCK_REQUEST_ACCEPTED`
oznacza tylko przyjęcie asynchronicznego żądania przez Windows.
[Kontrakt LockWorkStation](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-lockworkstation).

**Na tym etapie nie restartuj Windowsa.** Próba restartu wymaga osobnego momentu
przerwy i sprawdzenia dostępności aplikacji przed wejściem przez RDP. Zachowaj stare
zadanie `PhotoLocal Autostart` do późniejszego przełączenia produkcji; ten helper
nie zmienia uruchomionej Romki, portów ani kontenerów.

Wycofanie: otwórz oficjalny `Autologon64.exe` z lokalizacji `AutologonTool` podanej
w raporcie i wybierz **Disable**, następnie zamknij okno. Dopiero po wyłączeniu
automatycznego logowania można usunąć nasze zadanie. Poniższy blok sprawdza flagę
oraz zgodność zadania przed usunięciem wyłącznie `PhotoLocal Docker Console Lock`:

```powershell
. C:\PhotoLocal-staging\scripts\prepare-windows-autologon.ps1
$romekState = Get-PhotoLocalAutologonState
if ([string]$romekState.Enabled -eq '1') { throw 'Najpierw wybierz Disable w Microsoft Autologon.' }
$romekSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$romekSpec = New-PhotoLocalConsoleLockSpec -Root 'C:\PhotoLocal-staging' -Sid $romekSid
$romekTask = Get-ScheduledTask -TaskPath '\' -TaskName $romekSpec.Name -ErrorAction SilentlyContinue
if ($romekTask) {
    if (-not (Test-PhotoLocalConsoleLockTask -Task $romekTask -Spec $romekSpec)) {
        throw 'LOCK_TASK_CONFLICT'
    }
    Unregister-ScheduledTask -InputObject $romekTask -Confirm:$false
}
```
