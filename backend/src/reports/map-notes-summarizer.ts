import type { ProjectMapNote } from '../types.js';
import type { MapNotesSummary } from './map-notes-report.js';

export interface SummarizeMapNotesInput {
  projectName: string;
  notes: ProjectMapNote[];
  model?: string;
  ollamaUrl?: string;
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export type MapNotesSummarizer = (
  input: Pick<SummarizeMapNotesInput, 'projectName' | 'notes'>,
) => Promise<MapNotesSummary>;

const DEFAULT_NOTES_MODEL = 'qwen2.5vl:3b';
const DEFAULT_OLLAMA_URL = 'http://localhost:11434';
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

export function getDefaultNotesModel(): string {
  return (
    process.env.OLLAMA_NOTES_MODEL?.trim() ||
    process.env.OLLAMA_VISION_MODEL?.trim() ||
    DEFAULT_NOTES_MODEL
  );
}

export function parseMapNotesSummary(
  responseText: string,
  model: string,
  generatedAt?: string,
): MapNotesSummary {
  const jsonText = extractFirstJsonObject(responseText);
  let parsed: unknown;

  try {
    parsed = JSON.parse(jsonText);
  } catch (error) {
    throw new Error(`Invalid map notes summary JSON: ${getErrorMessage(error)}`);
  }

  if (!isRecord(parsed)) {
    throw new Error('Map notes summary JSON must be an object');
  }

  const overview = typeof parsed.overview === 'string' ? parsed.overview.trim() : '';
  if (!overview) {
    throw new Error('Map notes summary overview must be a non-empty string');
  }

  return {
    overview,
    blockers: normalizeStringArray(parsed.blockers),
    recommendedActions: normalizeStringArray(parsed.recommendedActions),
    attentionPoints: normalizeStringArray(parsed.attentionPoints),
    model,
    generatedAt: normalizeGeneratedAt(generatedAt),
  };
}

export async function summarizeMapNotes(
  input: SummarizeMapNotesInput,
): Promise<MapNotesSummary> {
  const model = input.model?.trim() || getDefaultNotesModel();
  const ollamaUrl =
    input.ollamaUrl?.trim() || process.env.OLLAMA_URL?.trim() || DEFAULT_OLLAMA_URL;
  const requestTimeoutMs = input.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  let response: Response;

  try {
    response = await fetchImpl(`${ollamaUrl.replace(/\/+$/, '')}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(requestTimeoutMs),
      body: JSON.stringify({
        model,
        stream: false,
        format: 'json',
        options: {
          temperature: 0,
          num_ctx: 8192,
        },
        messages: [
          {
            role: 'user',
            content: buildMapNotesPrompt(input.projectName, input.notes),
          },
        ],
      }),
    });
  } catch (error) {
    if (isTimeoutOrAbortError(error)) {
      throw new Error(`Ollama request timed out after ${requestTimeoutMs} ms`, { cause: error });
    }

    throw new Error(`Ollama request failed: ${getErrorMessage(error)}`, { cause: error });
  }

  let responseBody: string;
  try {
    responseBody = await response.text();
  } catch (error) {
    if (isTimeoutOrAbortError(error)) {
      throw new Error(`Ollama request timed out after ${requestTimeoutMs} ms`, { cause: error });
    }

    throw new Error(`Unable to read Ollama response: ${getErrorMessage(error)}`, {
      cause: error,
    });
  }

  if (!response.ok) {
    const errorBody = responseBody.trim() || '<empty response body>';
    throw new Error(`Ollama HTTP ${response.status}: ${errorBody}`);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(responseBody);
  } catch (error) {
    throw new Error(`Ollama response was not valid JSON: ${getErrorMessage(error)}`, {
      cause: error,
    });
  }

  const message = isRecord(payload) && isRecord(payload.message) ? payload.message : null;
  const content = message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('Ollama response did not include non-empty message.content');
  }

  return parseMapNotesSummary(content, model);
}

function buildMapNotesPrompt(projectName: string, notes: ProjectMapNote[]): string {
  const noteData = notes.map((note) => ({
    targetType: note.targetType,
    targetLabel: note.targetLabel,
    targetId: note.targetId,
    body: note.body,
    lat: note.lat,
    lng: note.lng,
    photoCount: note.photoCount,
    updatedAt: note.updatedAt,
  }));

  return [
    'Jestes asystentem kierownika budowy sieci FTTH.',
    'Przeanalizuj notatki z mapy pod katem blokad terenowych, kolejnych dzialan i punktow wymagajacych uwagi.',
    'Nie wymyslaj faktow, ktorych nie ma w notatkach.',
    '',
    `Projekt: ${projectName}`,
    '',
    'Notatki z mapy (bez zdjec):',
    JSON.stringify(noteData, null, 2),
    '',
    'Odpowiedz wylacznie poprawnym obiektem JSON bez markdown.',
    'Uzyj dokladnie kluczy: overview, blockers, recommendedActions, attentionPoints.',
    'overview ma byc niepustym stringiem, a pozostale pola tablicami krotkich stringow.',
    '{"overview":"...","blockers":["..."],"recommendedActions":["..."],"attentionPoints":["..."]}',
  ].join('\n');
}

function extractFirstJsonObject(text: string): string {
  const start = text.indexOf('{');
  if (start === -1) {
    throw new Error('Map notes summary response does not contain a JSON object');
  }

  let depth = 0;
  let isInsideString = false;
  let isEscaped = false;

  for (let index = start; index < text.length; index += 1) {
    const character = text[index];

    if (isInsideString) {
      if (isEscaped) {
        isEscaped = false;
      } else if (character === '\\') {
        isEscaped = true;
      } else if (character === '"') {
        isInsideString = false;
      }
      continue;
    }

    if (character === '"') {
      isInsideString = true;
    } else if (character === '{') {
      depth += 1;
    } else if (character === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }

  throw new Error('Map notes summary response does not contain a complete JSON object');
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeGeneratedAt(value: string | undefined): string {
  const date = value === undefined ? new Date() : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error('Map notes summary generatedAt must be a valid date');
  }

  return date.toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTimeoutOrAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
