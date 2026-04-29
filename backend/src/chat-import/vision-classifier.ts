import { readdir, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

import sharp from 'sharp';

export const RESERVE_LOCATIONS = ['W studni', 'Doziemny', 'Inne', 'Niepewne'] as const;

export type ReserveClassification = (typeof RESERVE_LOCATIONS)[number];

export interface VisionClassification {
  reserveLocation: ReserveClassification;
  confidence: number;
  visualEvidence: string[];
  reason?: string;
  shouldReview: boolean;
}

export interface ChatFolderClassification extends VisionClassification {
  folder: string;
  imageCount: number;
  sampledImages: string[];
  model: string;
  durationMs?: number;
  classifiedAt: string;
  rawResponse?: string;
  error?: string;
}

export interface ClassifyFolderInput {
  folderPath: string;
  model?: string;
  ollamaUrl?: string;
  maxImages?: number;
  imageMaxSize?: number;
  requestTimeoutMs?: number;
}

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp']);
const DEFAULT_MODEL = 'qwen2.5vl:3b';
const DEFAULT_OLLAMA_URL = 'http://localhost:11434';
const DEFAULT_MAX_IMAGES = 5;
const DEFAULT_IMAGE_MAX_SIZE = 768;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const REVIEW_CONFIDENCE_THRESHOLD = 0.85;

export function getDefaultVisionModel(): string {
  return process.env.OLLAMA_VISION_MODEL?.trim() || DEFAULT_MODEL;
}

export function decideReviewStatus(classification: VisionClassification): VisionClassification {
  const shouldReview =
    classification.shouldReview ||
    classification.reserveLocation === 'Niepewne' ||
    classification.reserveLocation === 'Inne' ||
    classification.confidence < REVIEW_CONFIDENCE_THRESHOLD;

  return {
    ...classification,
    shouldReview,
  };
}

export function parseModelList(value: string | undefined, fallback: string): string[] {
  const source = value?.trim() ? value : fallback;
  const models = source
    .split(',')
    .map((model) => model.trim())
    .filter(Boolean);

  return models.length > 0 ? models : [fallback];
}

export function parseVisionClassification(responseText: string): VisionClassification {
  const jsonText = extractJsonObject(responseText);
  const parsed = JSON.parse(jsonText) as Record<string, unknown>;
  const reserveLocation = normalizeReserveLocation(parsed.reserveLocation);
  const confidence =
    typeof parsed.confidence === 'number' && Number.isFinite(parsed.confidence)
      ? clamp(parsed.confidence, 0, 1)
      : 0;
  const visualEvidence = Array.isArray(parsed.visualEvidence)
    ? parsed.visualEvidence.map(extractEvidenceText).filter((item): item is string => Boolean(item))
    : [];
  const reason = typeof parsed.reason === 'string' ? parsed.reason.trim() : undefined;

  return decideReviewStatus({
    reserveLocation,
    confidence,
    visualEvidence,
    reason,
    shouldReview: false,
  });
}

export async function classifyChatFolder(
  input: ClassifyFolderInput,
): Promise<ChatFolderClassification> {
  const model = input.model ?? getDefaultVisionModel();
  const ollamaUrl = input.ollamaUrl ?? DEFAULT_OLLAMA_URL;
  const maxImages = input.maxImages ?? DEFAULT_MAX_IMAGES;
  const imageMaxSize = input.imageMaxSize ?? DEFAULT_IMAGE_MAX_SIZE;
  const requestTimeoutMs = input.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const folderPath = resolve(input.folderPath);
  const imagePaths = await listImageFiles(folderPath);

  if (imagePaths.length === 0) {
    return {
      folder: basename(folderPath),
      imageCount: 0,
      sampledImages: [],
      model,
      classifiedAt: new Date().toISOString(),
      reserveLocation: 'Niepewne',
      confidence: 0,
      visualEvidence: [],
      reason: 'Folder nie zawiera obslugiwanych plikow graficznych.',
      shouldReview: true,
    };
  }

  const attempts = [
    { maxImages, imageMaxSize },
    { maxImages: Math.min(maxImages, 3), imageMaxSize: Math.min(imageMaxSize, 512), resetModel: true },
  ];
  let rawResponse = '';
  let sampledPaths = imagePaths.slice(0, maxImages);
  let lastError: unknown = null;

  for (const attempt of attempts) {
    if (attempt.resetModel) {
      await unloadOllamaModel({ ollamaUrl, model });
    }

    sampledPaths = imagePaths.slice(0, attempt.maxImages);
    const images = await Promise.all(
      sampledPaths.map((imagePath) => prepareImageForOllama(imagePath, attempt.imageMaxSize)),
    );
    rawResponse = await callOllamaVision({
      ollamaUrl,
      model,
      folderName: basename(folderPath),
      images,
      requestTimeoutMs,
    });

    try {
      if (isDegenerateModelResponse(rawResponse)) {
        throw new Error('Model response degenerated into repeated punctuation');
      }
      const parsed = parseVisionClassification(rawResponse);
      return {
        folder: basename(folderPath),
        imageCount: imagePaths.length,
        sampledImages: sampledPaths.map((imagePath) => basename(imagePath)),
        model,
        classifiedAt: new Date().toISOString(),
        rawResponse,
        ...parsed,
      };
    } catch (error) {
      lastError = error;
    }
  }

  return {
    folder: basename(folderPath),
    imageCount: imagePaths.length,
    sampledImages: sampledPaths.map((imagePath) => basename(imagePath)),
    model,
    classifiedAt: new Date().toISOString(),
    rawResponse,
    reserveLocation: 'Niepewne',
    confidence: 0,
    visualEvidence: [],
    reason: `Nie udalo sie sparsowac odpowiedzi modelu: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
    shouldReview: true,
  };
}

export async function appendJsonLine(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value)}\n`, { flag: 'a' });
}

async function listImageFiles(folderPath: string): Promise<string[]> {
  const entries = await readdir(folderPath, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && IMAGE_EXTENSIONS.has(getLowerExtension(entry.name)))
    .map((entry) => join(folderPath, entry.name))
    .sort((a, b) => a.localeCompare(b, 'pl'));
}

async function prepareImageForOllama(imagePath: string, maxSize: number): Promise<string> {
  const buffer = await sharp(imagePath)
    .rotate()
    .resize(maxSize, maxSize, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 78 })
    .toBuffer();

  return buffer.toString('base64');
}

async function callOllamaVision(input: {
  ollamaUrl: string;
  model: string;
  folderName: string;
  images: string[];
  requestTimeoutMs: number;
}): Promise<string> {
  const response = await fetch(`${input.ollamaUrl.replace(/\/$/, '')}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(input.requestTimeoutMs),
    body: JSON.stringify({
      model: input.model,
      stream: false,
      format: 'json',
      options: {
        temperature: 0,
        num_ctx: 4096,
      },
      messages: [
        {
          role: 'user',
          content: buildPrompt(input.folderName, input.images.length),
          images: input.images,
        },
      ],
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Ollama HTTP ${response.status}: ${text}`);
  }

  const payload = (await response.json()) as { message?: { content?: unknown } };
  const content = payload.message?.content;
  if (typeof content !== 'string' || content.trim() === '') {
    throw new Error('Ollama response did not include message.content');
  }

  return content;
}

async function unloadOllamaModel(input: { ollamaUrl: string; model: string }): Promise<void> {
  try {
    await fetch(`${input.ollamaUrl.replace(/\/$/, '')}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: input.model,
        keep_alive: 0,
      }),
    });
  } catch {
    // Best effort only. The retry still runs even if Ollama refuses unload.
  }
}

function isDegenerateModelResponse(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return true;
  const bangCount = [...trimmed].filter((char) => char === '!').length;
  return bangCount >= 12 && bangCount / trimmed.length > 0.2;
}

function buildPrompt(folderName: string, imageCount: number): string {
  return [
    'Jestes klasyfikatorem zdjec z budowy sieci swiatlowodowej.',
    'Masz rozpoznac typ zapasu kabla na podstawie DOLACZONYCH ZDJEC, nie na podstawie samego podpisu.',
    `Dostajesz dokladnie ${imageCount} ${imageCount === 1 ? 'zdjecie' : 'zdjec'}. Nie opisuj ani nie wymyslaj innych zdjec.`,
    '',
    `Nazwa paczki z Google Chat: ${folderName}`,
    '',
    'Wybierz dokladnie jedna etykiete:',
    '- "W studni": widac studnie/komore/zasobnik, jej sciany, wnetrze, dno, pokrywe albo kabel ulozony wewnatrz tej studni. Jesli kabel lezy na ziemi lub dnie, ale wewnatrz studni/komory, to nadal jest "W studni".',
    '- "Doziemny": zapas kabla/rury lezy w otwartym wykopie, bez widocznej studni, komory, zasobnika lub pokrywy. To moze byc granica dzialki, ziemia, trawa, piasek, rura HDPE, ale bez komory.',
    '- "Inne": zdjecia nie przedstawiaja zapasu kabla.',
    '- "Niepewne": nie da sie pewnie rozpoznac albo zdjecia sa mieszane.',
    '',
    'Najpierw ocen kazde zdjecie osobno, potem wybierz etykiete dla calej paczki.',
    'Jesli na ktorymkolwiek zdjeciu widac studnie/komore/zasobnik i zapas jest z nia zwiazany, preferuj "W studni".',
    'Jesli choc jedno zdjecie przeczy reszcie albo paczka wyglada na mieszana, ustaw "Niepewne".',
    'visualEvidence ma byc tablica krotkich stringow. Nie dodawaj image_url, obiektow ani markdown.',
    'Odpowiedz wylacznie poprawnym JSON, bez markdown:',
    '{"reserveLocation":"W studni","confidence":0.0,"visualEvidence":["..."],"reason":"..."}',
    'W polu reserveLocation wpisz jedna dokladna wartosc: "W studni", "Doziemny", "Inne" albo "Niepewne". Nie wpisuj listy opcji.',
  ].join('\n');
}

function extractJsonObject(text: string): string {
  const fenceMatch = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fenceMatch?.[1] ?? text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');

  if (start === -1 || end === -1 || end <= start) {
    throw new Error('Model response does not contain a JSON object');
  }

  return candidate.slice(start, end + 1);
}

function normalizeReserveLocation(value: unknown): ReserveClassification {
  if (value === 'W studni' || value === 'Doziemny' || value === 'Inne' || value === 'Niepewne') {
    return value;
  }

  return 'Niepewne';
}

function extractEvidenceText(item: unknown): string | null {
  if (typeof item === 'string') {
    const value = item.trim();
    return value ? value : null;
  }

  if (item && typeof item === 'object' && 'description' in item) {
    const description = (item as { description?: unknown }).description;
    if (typeof description === 'string') {
      const value = description.trim();
      return value ? value : null;
    }
  }

  return null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function getLowerExtension(fileName: string): string {
  const dotIndex = fileName.lastIndexOf('.');
  return dotIndex === -1 ? '' : fileName.slice(dotIndex).toLowerCase();
}
