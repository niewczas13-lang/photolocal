# Photo Local

Lokalna aplikacja do pilnowania zdjec projektowych. Dziala na jednym komputerze, zapisuje baze SQLite lokalnie i tworzy strukture zdjec w folderze wskazanym przy tworzeniu zadania.

## Uruchomienie

1. Kliknij `start.bat`.
2. Poczekaj kilka sekund.
3. Przegladarka powinna otworzyc `http://localhost:4873`.

Jesli aplikacja juz dziala, `start.bat` tylko otworzy strone.

## Zatrzymanie

Kliknij `stop.bat`.

## Konfiguracja

Przy pierwszym starcie aplikacja skopiuje `.env.example` do `.env`.

Domyslne miejsca:

- baza aplikacji: `photo-local/data/photo-local.sqlite`
- logi: `photo-local/logs`
- port: `4873`

Folder zdjec nie jest juz globalnie ustawiany w `.env`. Wybierasz go osobno przy tworzeniu zadania.

## Praca w aplikacji

1. Utworz zadanie.
2. Wybierz plik `.gpkg`.
3. W polu `Folder zadania` wpisz folder roboczy zadania, np. `D:\projekty\opp13\pw\sap`.
4. Aplikacja utworzy folder `D:\projekty\opp13\pw\sap\zdjecia`.
5. Wybierz typ `SI` albo `KPO`.
6. Zostaw automatyczne wykrycie splitterow albo wybierz recznie `1 spliter` / `Kaskada`.
7. Wejdz w zadanie, kliknij punkt checklisty i przeciagaj zdjecia na okno.
8. Punkty, ktore nie sa potrzebne w danym zadaniu, oznacz jako `Nie dotyczy`.

Zdjecia sa zmniejszane, konwertowane do JPEG i zapisywane w folderze `zdjecia` wybranego zadania. Miniatury sa zapisywane w `zdjecia\.thumbnails`.

Przyklad struktury:

```text
D:\projekty\opp13\pw\sap\
  zdjecia\
    .thumbnails\
    Zapasy_kabli_instalacyjnych\
    Wykopy_Przeciski\
    OSD2766\
```

## Google Chat i Qwen/Ollama

Klasyfikacja paczek z Google Chat uzywa lokalnej Ollamy.

Minimalnie potrzebujesz:

1. Zainstalowana Ollama: `https://ollama.com/download`
2. Pobrany model vision:

```powershell
ollama pull qwen2.5vl:3b
```

3. Uruchomiona Ollama w tle. Po instalacji Windows zwykle startuje ja automatycznie.
4. Opcjonalnie ustaw model w `photo-local\.env`:

```env
OLLAMA_VISION_MODEL=qwen2.5vl:3b
```

Test Ollamy:

```powershell
ollama list
curl.exe http://localhost:11434/api/tags
```

## Przeniesienie na inny komputer

### 1. Zainstaluj wymagane programy

Na nowym komputerze zainstaluj:

- Node.js LTS: `https://nodejs.org/`
- Ollama: `https://ollama.com/download`
- Git, jesli przenosisz projekt przez repozytorium: `https://git-scm.com/download/win`

Jesli `npm install` bedzie mial problem z pakietami natywnymi typu `better-sqlite3` albo `sharp`, doinstaluj `Visual Studio Build Tools` z komponentem `Desktop development with C++`.

### 2. Skopiuj aplikacje

Skopiuj caly folder `photo-local` na nowy komputer albo pobierz repozytorium i wejdz do folderu:

```powershell
cd C:\sciezka\do\photo-local
```

### 3. Zainstaluj paczki Node

```powershell
npm install --workspaces
```

### 4. Zbuduj aplikacje

```powershell
npm run build
```

### 5. Przygotuj `.env`

Jesli plik `photo-local\.env` nie istnieje, skopiuj `.env.example` do `.env`.

Typowa konfiguracja:

```env
PHOTO_LOCAL_PORT=4873
PHOTO_LOCAL_DB=.\data\photo-local.sqlite
PHOTO_LOCAL_LOG=.\logs\app.log
OLLAMA_VISION_MODEL=qwen2.5vl:3b
```

### 6. Przygotuj Ollame

```powershell
ollama pull qwen2.5vl:3b
ollama list
```

### 7. Uruchom aplikacje

Najprosciej:

```powershell
.\start.bat
```

Albo recznie:

```powershell
npm run start
```

Strona lokalna:

```text
http://localhost:4873
```

### 8. Przeniesienie istniejacych danych

Jesli chcesz zabrac stare projekty:

1. Skopiuj baze SQLite: `photo-local\data\photo-local.sqlite`.
2. Skopiuj foldery zdjec, ktore byly wybrane przy tworzeniu zadan, np. `D:\projekty\opp13\pw\sap\zdjecia`.
3. Na nowym komputerze najlepiej zachowaj te same sciezki dyskowe.

Jesli sciezki beda inne, stare projekty w bazie nadal beda wskazywaly na poprzednie lokalizacje. Wtedy trzeba albo odtworzyc te same sciezki, albo poprawic `base_folder` w tabeli `projects` w bazie SQLite.

### 9. Dostep z internetu przez Cloudflare

Na nowym komputerze potrzebujesz:

1. Zainstalowane `cloudflared`.
2. Dzialajacy ten sam albo nowy Cloudflare Tunnel.
3. Public hostname kierujacy na lokalny port aplikacji, np. `http://localhost:4873`.
4. Cloudflare Access wlaczony dla prywatnych subdomen.

Jesli uzywasz istniejacego tunelu z poprzedniego komputera, trzeba uruchomic connector na nowym komputerze albo przepiac hostname na tunel dzialajacy na nowym komputerze.
