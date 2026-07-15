import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ProjectMapNote } from '../types.js';
import {
  getDefaultNotesModel,
  parseMapNotesSummary,
  summarizeMapNotes,
} from './map-notes-summarizer.js';

const originalNotesModel = process.env.OLLAMA_NOTES_MODEL;
const originalVisionModel = process.env.OLLAMA_VISION_MODEL;
const originalOllamaUrl = process.env.OLLAMA_URL;

type CreateNoteInput = Pick<ProjectMapNote, 'id' | 'targetType' | 'body'> &
  Partial<Omit<ProjectMapNote, 'id' | 'targetType' | 'body'>>;

interface OllamaRequestBody {
  model: string;
  stream: boolean;
  format: string;
  options: {
    temperature: number;
    num_ctx: number;
  };
  messages: Array<{
    role: string;
    content: string;
    images?: unknown;
  }>;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}

function createNote({ id, targetType, body, ...overrides }: CreateNoteInput): ProjectMapNote {
  return {
    id,
    targetType,
    targetId: null,
    targetLabel: null,
    body,
    lat: null,
    lng: null,
    photoCount: 0,
    photos: [],
    createdAt: '2026-07-15T10:00:00.000Z',
    updatedAt: '2026-07-15T11:00:00.000Z',
    ...overrides,
  };
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  restoreEnv('OLLAMA_NOTES_MODEL', originalNotesModel);
  restoreEnv('OLLAMA_VISION_MODEL', originalVisionModel);
  restoreEnv('OLLAMA_URL', originalOllamaUrl);
});

describe('getDefaultNotesModel', () => {
  it('uses and trims OLLAMA_NOTES_MODEL first', () => {
    process.env.OLLAMA_NOTES_MODEL = '  qwen-notes:7b  ';
    process.env.OLLAMA_VISION_MODEL = 'qwen-vision:8b';

    expect(getDefaultNotesModel()).toBe('qwen-notes:7b');
  });

  it('falls back to a trimmed OLLAMA_VISION_MODEL', () => {
    process.env.OLLAMA_NOTES_MODEL = '   ';
    process.env.OLLAMA_VISION_MODEL = '  qwen-vision:8b  ';

    expect(getDefaultNotesModel()).toBe('qwen-vision:8b');
  });

  it('falls back to qwen2.5vl:3b when both environment values are blank', () => {
    delete process.env.OLLAMA_NOTES_MODEL;
    process.env.OLLAMA_VISION_MODEL = '   ';

    expect(getDefaultNotesModel()).toBe('qwen2.5vl:3b');
  });
});

describe('parseMapNotesSummary', () => {
  it('extracts the first fenced object, trims strings, and filters invalid array entries', () => {
    const result = parseMapNotesSummary(
      [
        'Oto analiza:',
        '```json',
        '{',
        '  "overview": "  Projekt {FTTH} wymaga interwencji.  ",',
        '  "blockers": ["  Niedroznosc kabla  ", "", 7, null, "Brak dostepu"],',
        '  "recommendedActions": ["  Wykonac inspekcje  ", {}, "   "],',
        '  "attentionPoints": "niepoprawna tablica"',
        '}',
        '```',
        'Komentarz po JSON: {"overview":"Nie wybieraj tego obiektu"}',
      ].join('\n'),
      'qwen-notes:7b',
      '2026-07-15T12:34:56.000Z',
    );

    expect(result).toEqual({
      overview: 'Projekt {FTTH} wymaga interwencji.',
      blockers: ['Niedroznosc kabla', 'Brak dostepu'],
      recommendedActions: ['Wykonac inspekcje'],
      attentionPoints: [],
      model: 'qwen-notes:7b',
      generatedAt: '2026-07-15T12:34:56.000Z',
    });
  });

  it('uses empty arrays when list fields are missing or are not arrays', () => {
    const result = parseMapNotesSummary(
      '{"overview":"Gotowe","blockers":null,"recommendedActions":{}}',
      'qwen2.5vl:3b',
      '2026-07-15T12:34:56.000Z',
    );

    expect(result.blockers).toEqual([]);
    expect(result.recommendedActions).toEqual([]);
    expect(result.attentionPoints).toEqual([]);
  });

  it.each(['{}', '{"overview":"   "}'])('rejects a missing or blank overview: %s', (text) => {
    expect(() => parseMapNotesSummary(text, 'qwen2.5vl:3b')).toThrow(
      'Map notes summary overview must be a non-empty string',
    );
  });

  it('rejects malformed JSON with a readable error', () => {
    expect(() =>
      parseMapNotesSummary('Model: {"overview":"Gotowe",}', 'qwen2.5vl:3b'),
    ).toThrow(/Invalid map notes summary JSON/);
  });
});

describe('summarizeMapNotes', () => {
  it('sends a bounded text-only Ollama request with all note metadata and parses the result', async () => {
    process.env.OLLAMA_URL = 'http://environment-ollama:11434';
    process.env.OLLAMA_NOTES_MODEL = 'environment-model';
    const notes = [
      createNote({
        id: 'cable-note',
        targetType: 'cable',
        targetId: 'cable-17',
        targetLabel: 'Kabel K-17',
        body: 'Niedroznosc przy przejsciu pod droga',
        lat: 53.721,
        lng: 20.512,
        photoCount: 1,
        photos: [
          {
            id: 'photo-1',
            noteId: 'cable-note',
            sourceFileName: 'nie-wysylaj.jpg',
            storedFileName: 'photo-1.jpg',
            storagePath: 'C:/photos/photo-1.jpg',
            thumbnailPath: null,
            mimeType: 'image/jpeg',
            fileSize: 1234,
            lat: null,
            lng: null,
            capturedAt: null,
            uploadedAt: '2026-07-15T10:30:00.000Z',
          },
        ],
        updatedAt: '2026-07-15T12:00:00.000Z',
      }),
      createNote({
        id: 'node-note',
        targetType: 'node',
        targetId: 'node-22',
        body: 'Brak dostepu do studni',
        photoCount: 0,
        updatedAt: '2026-07-15T12:30:00.000Z',
      }),
    ];
    let requestedUrl: Parameters<typeof fetch>[0] | undefined;
    let requestedInit: RequestInit | undefined;
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    const fetchImpl: typeof fetch = async (url, init) => {
      requestedUrl = url;
      requestedInit = init;
      return jsonResponse({
        message: {
          content:
            '{"overview":"  Dwie kwestie terenowe.  ","blockers":[" Niedroznosc "],"recommendedActions":[" Inspekcja "],"attentionPoints":[]}',
        },
      });
    };

    const result = await summarizeMapNotes({
      projectName: 'Projekt Olsztyn FTTH',
      notes,
      model: 'qwen-notes:test',
      ollamaUrl: '  http://input-ollama:11434///  ',
      fetchImpl,
    });

    expect(String(requestedUrl)).toBe('http://input-ollama:11434/api/chat');
    expect(requestedInit?.method).toBe('POST');
    expect(requestedInit?.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(timeoutSpy).toHaveBeenCalledWith(120_000);
    expect(requestedInit?.signal).toBeInstanceOf(AbortSignal);

    const body = JSON.parse(String(requestedInit?.body)) as OllamaRequestBody;
    expect(body).toEqual({
      model: 'qwen-notes:test',
      stream: false,
      format: 'json',
      options: { temperature: 0, num_ctx: 8192 },
      messages: [{ role: 'user', content: expect.any(String) }],
    });

    const prompt = body.messages[0].content;
    expect(prompt).toContain('Jestes asystentem kierownika budowy sieci FTTH.');
    expect(prompt).toContain('Przeanalizuj notatki z mapy pod katem blokad terenowych');
    expect(prompt).not.toMatch(/[\u0139\u00c4\u00c5\u0102]/);
    expect(prompt).toMatch(/^[\x00-\x7f]*$/);
    for (const value of [
      'Projekt Olsztyn FTTH',
      'cable',
      'cable-17',
      'Kabel K-17',
      'Niedroznosc przy przejsciu pod droga',
      '53.721',
      '20.512',
      '"photoCount": 1',
      '2026-07-15T12:00:00.000Z',
      'node',
      'node-22',
      'Brak dostepu do studni',
      '"lat": null',
      '"lng": null',
      '"photoCount": 0',
      '2026-07-15T12:30:00.000Z',
      'overview',
      'blockers',
      'recommendedActions',
      'attentionPoints',
    ]) {
      expect(prompt).toContain(value);
    }
    expect(body.messages[0]).not.toHaveProperty('images');
    expect(prompt).not.toContain('nie-wysylaj.jpg');
    expect(prompt).not.toContain('C:/photos/photo-1.jpg');

    expect(result).toMatchObject({
      overview: 'Dwie kwestie terenowe.',
      blockers: ['Niedroznosc'],
      recommendedActions: ['Inspekcja'],
      attentionPoints: [],
      model: 'qwen-notes:test',
    });
    expect(result.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(new Date(result.generatedAt).toISOString()).toBe(result.generatedAt);
  });

  it('uses the trimmed OLLAMA_URL when no input URL is provided', async () => {
    process.env.OLLAMA_URL = '  http://environment-ollama:11434///  ';
    let requestedUrl: Parameters<typeof fetch>[0] | undefined;
    const fetchImpl: typeof fetch = async (url) => {
      requestedUrl = url;
      return jsonResponse({ message: { content: '{"overview":"Gotowe"}' } });
    };

    await summarizeMapNotes({
      projectName: 'Projekt testowy',
      notes: [],
      fetchImpl,
    });

    expect(String(requestedUrl)).toBe('http://environment-ollama:11434/api/chat');
  });

  it('uses the localhost Ollama URL when OLLAMA_URL is unset or blank', async () => {
    const requestedUrls: Array<Parameters<typeof fetch>[0]> = [];
    const fetchImpl: typeof fetch = async (url) => {
      requestedUrls.push(url);
      return jsonResponse({ message: { content: '{"overview":"Gotowe"}' } });
    };

    delete process.env.OLLAMA_URL;
    await summarizeMapNotes({ projectName: 'Projekt bez env', notes: [], fetchImpl });

    process.env.OLLAMA_URL = '   ';
    await summarizeMapNotes({ projectName: 'Projekt z pustym env', notes: [], fetchImpl });

    expect(requestedUrls.map(String)).toEqual([
      'http://localhost:11434/api/chat',
      'http://localhost:11434/api/chat',
    ]);
  });

  it('wraps Ollama connection failures and preserves the original cause', async () => {
    const connectionError = new Error('connect ECONNREFUSED');
    const fetchImpl: typeof fetch = async () => {
      throw connectionError;
    };

    await expect(
      summarizeMapNotes({
        projectName: 'Projekt testowy',
        notes: [],
        fetchImpl,
      }),
    ).rejects.toMatchObject({
      message: 'Ollama request failed: connect ECONNREFUSED',
      cause: connectionError,
    });
  });

  it('reports Ollama timeouts with the configured duration and preserves the cause', async () => {
    const timeoutError = new DOMException('The operation timed out', 'TimeoutError');
    const fetchImpl: typeof fetch = async () => {
      throw timeoutError;
    };

    await expect(
      summarizeMapNotes({
        projectName: 'Projekt testowy',
        notes: [],
        requestTimeoutMs: 4321,
        fetchImpl,
      }),
    ).rejects.toMatchObject({
      message: 'Ollama request timed out after 4321 ms',
      cause: timeoutError,
    });
  });

  it('reports response-body read failures separately from malformed JSON', async () => {
    const readError = new Error('response stream failed');
    const response = {
      ok: true,
      status: 200,
      text: async () => {
        throw readError;
      },
      json: async () => {
        throw readError;
      },
    } as unknown as Response;
    const fetchImpl: typeof fetch = async () => response;

    await expect(
      summarizeMapNotes({
        projectName: 'Projekt testowy',
        notes: [],
        fetchImpl,
      }),
    ).rejects.toMatchObject({
      message: 'Unable to read Ollama response: response stream failed',
      cause: readError,
    });
  });

  it('includes the Ollama status and response body in HTTP errors', async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response('model is not available', { status: 503 });

    await expect(
      summarizeMapNotes({
        projectName: 'Projekt testowy',
        notes: [],
        fetchImpl,
      }),
    ).rejects.toThrow('Ollama HTTP 503: model is not available');
  });

  it.each([
    {},
    { message: {} },
    { message: { content: '   ' } },
  ])('reports missing or empty message.content: %#', async (payload) => {
    const fetchImpl: typeof fetch = async () => jsonResponse(payload);

    await expect(
      summarizeMapNotes({
        projectName: 'Projekt testowy',
        notes: [],
        fetchImpl,
      }),
    ).rejects.toThrow('Ollama response did not include non-empty message.content');
  });

  it('reports a malformed Ollama response body', async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response('{not-json', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });

    await expect(
      summarizeMapNotes({
        projectName: 'Projekt testowy',
        notes: [],
        fetchImpl,
      }),
    ).rejects.toThrow(/Ollama response was not valid JSON/);
  });
});
