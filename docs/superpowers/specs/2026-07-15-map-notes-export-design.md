# Map Notes Export Design

## Goal

Add a project-level XLSX export for map notes that are not attached to addresses, with an optional Qwen-generated operational summary.

## Scope

- Export notes with `targetType` equal to `cable`, `node`, `polygon`, or `free`.
- Exclude notes with `targetType` equal to `address`, because address comments are already included in the address construction report.
- Keep both exports available from the existing `Notatki` map view.
- Do not change note storage, note editing, or the existing address report.

## User Interface

The `Notatki z mapy` header will contain two actions:

- `Eksport XLSX` downloads the report without contacting Ollama.
- `Eksport + Qwen` asks Qwen for a summary and downloads the same report with an additional summary sheet.

Both actions show a busy state while their request is running. A Qwen failure produces a readable error and does not affect the regular XLSX export.

## Report Structure

The first worksheet, `Notatki`, contains:

- sequence number;
- note type in Polish;
- target object label;
- note body;
- latitude and longitude;
- photo count;
- creation timestamp;
- update timestamp.

The Qwen variant adds a second worksheet, `Podsumowanie Qwen`, containing:

- a concise project summary;
- blockers and risks;
- recommended next actions;
- locations or objects requiring attention.

An empty project still produces a valid workbook with headers and a clear `Brak notatek` row. In Qwen mode, no model request is made when there are no eligible notes.

## Backend Design

- A focused report module filters eligible notes and builds the XLSX workbook with the existing `xlsx-writer`.
- A separate text summarizer sends only eligible note metadata to Ollama `/api/chat` and parses a structured JSON response.
- The summarizer uses `OLLAMA_NOTES_MODEL` when configured, otherwise `OLLAMA_VISION_MODEL`, and finally `qwen2.5vl:3b`. It uses `OLLAMA_URL` and a bounded request timeout.
- `GET /api/projects/:projectId/reports/map-notes.xlsx` returns the regular report.
- `GET /api/projects/:projectId/reports/map-notes.xlsx?summary=qwen` returns the report with the Qwen worksheet.
- Unknown projects return `404`; invalid summary modes return `400`; Ollama errors return `502` with a readable message.

## Data Flow

1. The user opens `Notatki` for a project and chooses an export action.
2. The frontend requests the project report, optionally with `summary=qwen`.
3. The backend reads the current project map and removes address notes.
4. In Qwen mode, the backend summarizes the filtered notes.
5. The backend generates and returns the XLSX file.
6. The frontend downloads it using the project name in the file name.

## Testing

- Report unit tests verify filtering, Polish labels, empty exports, and the optional summary worksheet.
- Summarizer unit tests verify prompt content, JSON parsing, model selection, malformed responses, and HTTP failures using a fake `fetch`.
- Route tests verify the regular download, the Qwen download, filtering, response headers, and error handling.
- Frontend tests cover the report download helper and presentation state where practical; TypeScript and the production build verify component integration.

