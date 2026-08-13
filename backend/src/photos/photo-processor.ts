import exifr from 'exifr';
import { extname, join } from 'node:path';
import sharp from 'sharp';
import { safeFolderName } from '../utils/path-names.js';

export const RESERVE_LOCATIONS = ['Doziemny', 'W studni', 'Napowietrzny'] as const;
export const MAX_PROCESSED_PHOTO_BYTES = 200 * 1024;

const MAX_PHOTO_DIMENSION = 2048;
const MIN_PHOTO_DIMENSION = 128;
const JPEG_QUALITY_STEPS = [82, 64, 48, 36] as const;
const MAX_RESIZE_ROUNDS = 8;

export type ReserveLocation = (typeof RESERVE_LOCATIONS)[number];

export function isReserveLocation(value: unknown): value is ReserveLocation {
  return typeof value === 'string' && RESERVE_LOCATIONS.includes(value as ReserveLocation);
}

export interface ResolvePhotoTargetInput {
  projectFolder: string;
  nodePath: string;
  nodeName: string;
  existingCount: number;
  reserveLocation: ReserveLocation | null;
  sourceFileName: string;
}

export interface PhotoTarget {
  relativeFolder: string;
  fileName: string;
  absolutePath: string;
}

export interface ProcessedPhoto {
  buffer: Buffer;
  thumbnail: Buffer;
  mimeType: 'image/jpeg';
  lat: number | null;
  lng: number | null;
  capturedAt: string | null;
  fileSize: number;
}

export interface ProcessPhotoOptions {
  fallbackCapturedAt?: string | Date | null;
}

export interface PhotoCaptionInput {
  capturedAt: string | null;
  lat: number | null;
  lng: number | null;
}

export function buildReservePhotoName(addressName: string, index: number): string {
  return `${safeFolderName(addressName)}_foto${index}.jpeg`;
}

export function resolvePhotoTarget(input: ResolvePhotoTargetInput): PhotoTarget {
  if (
    (input.nodePath.startsWith('Zapasy_kabli_instalacyjnych') ||
      input.nodePath.startsWith('Zapasy_kabli_napowietrznych')) &&
    input.reserveLocation
  ) {
    const root = input.reserveLocation === 'Napowietrzny'
      ? 'Zapasy_kabli_napowietrznych'
      : 'Zapasy_kabli_instalacyjnych';
    const installType =
      input.reserveLocation === 'Doziemny'
        ? 'Zapasy_doziemne'
        : input.reserveLocation === 'W studni'
          ? 'Zapasy_w_studni'
          : 'Zapasy_napowietrzne';
    const addressName = safeFolderName(input.nodeName);
    const relativeFolder = `${root}/${installType}/${addressName}`;
    const fileName = buildReservePhotoName(addressName, input.existingCount + 1);
    return {
      relativeFolder,
      fileName,
      absolutePath: join(input.projectFolder, relativeFolder, fileName),
    };
  }

  const ext = extname(input.sourceFileName).toLowerCase();
  const base = safeFolderName(input.sourceFileName.replace(ext, ''));
  const fileName = `${base || 'ZDJECIE'}_${input.existingCount + 1}.jpeg`;
  const relativeFolder = input.nodePath;
  return {
    relativeFolder,
    fileName,
    absolutePath: join(input.projectFolder, relativeFolder, fileName),
  };
}

interface EncodedPhotoAttempt {
  matching: Buffer | null;
  smallest: Buffer;
}

function normalizeCapturedAt(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;

  let date: Date;
  if (value instanceof Date) {
    date = value;
  } else if (typeof value === 'string') {
    const exifMatch = value.match(
      /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/,
    );
    date = exifMatch
      ? new Date(
          Number(exifMatch[1]),
          Number(exifMatch[2]) - 1,
          Number(exifMatch[3]),
          Number(exifMatch[4]),
          Number(exifMatch[5]),
          Number(exifMatch[6]),
        )
      : new Date(value);
  } else if (typeof value === 'number') {
    date = new Date(value);
  } else {
    return null;
  }

  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function toFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function formatCapturedAt(value: string): string | null {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  const values = Object.fromEntries(
    new Intl.DateTimeFormat('pl-PL', {
      timeZone: 'Europe/Warsaw',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );

  return `${values.day}.${values.month}.${values.year} ${values.hour}:${values.minute}:${values.second}`;
}

export function buildPhotoCaption(input: PhotoCaptionInput): string {
  const parts: string[] = [];
  const formattedDate = input.capturedAt ? formatCapturedAt(input.capturedAt) : null;

  if (formattedDate) parts.push(`Data: ${formattedDate}`);
  if (input.lat !== null && input.lng !== null) {
    parts.push(`GPS: ${input.lat.toFixed(6)}, ${input.lng.toFixed(6)}`);
  }

  return parts.join(' | ');
}

function escapeSvgText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function addPhotoCaption(source: Buffer, caption: string): Promise<Buffer> {
  if (!caption) return source;

  const metadata = await sharp(source).metadata();
  const width = metadata.width ?? MAX_PHOTO_DIMENSION;
  const height = metadata.height ?? MAX_PHOTO_DIMENSION;
  if (width < 120 || height < 40) return source;

  const availableWidth = Math.max(1, width - 24);
  const estimatedTextWidth = Math.max(1, caption.length * 0.58);
  const fontSize = Math.max(10, Math.min(26, Math.floor(availableWidth / estimatedTextWidth)));
  const barHeight = fontSize + 18;
  const svg = Buffer.from(`
    <svg width="${width}" height="${barHeight}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${width}" height="${barHeight}" fill="rgba(0,0,0,0.74)"/>
      <text x="12" y="${fontSize + 9}" font-family="Arial, sans-serif" font-size="${fontSize}" font-weight="600" fill="#ffffff">${escapeSvgText(caption)}</text>
    </svg>
  `);

  return sharp(source).composite([{ input: svg, gravity: 'south' }]).toBuffer();
}

async function encodeAtBestQuality(source: Buffer): Promise<EncodedPhotoAttempt> {
  let previousFailedQuality: number | null = null;
  let smallest: Buffer = Buffer.alloc(0);

  for (const quality of JPEG_QUALITY_STEPS) {
    const encoded = await sharp(source).jpeg({ quality }).toBuffer();
    smallest = encoded;

    if (encoded.length > MAX_PROCESSED_PHOTO_BYTES) {
      previousFailedQuality = quality;
      continue;
    }

    let best = encoded;
    if (previousFailedQuality !== null) {
      let lowerQuality = quality + 1;
      let upperQuality = previousFailedQuality - 1;

      while (lowerQuality <= upperQuality) {
        const candidateQuality = Math.floor((lowerQuality + upperQuality) / 2);
        const candidate = await sharp(source).jpeg({ quality: candidateQuality }).toBuffer();

        if (candidate.length <= MAX_PROCESSED_PHOTO_BYTES) {
          best = candidate;
          lowerQuality = candidateQuality + 1;
        } else {
          upperQuality = candidateQuality - 1;
        }
      }
    }

    return { matching: best, smallest: best };
  }

  return { matching: null, smallest };
}

async function compressPhoto(sourceBuffer: Buffer, caption: string): Promise<Buffer> {
  let dimension = MAX_PHOTO_DIMENSION;

  for (let round = 0; round < MAX_RESIZE_ROUNDS; round += 1) {
    const resized = await sharp(sourceBuffer)
      .autoOrient()
      .resize(dimension, dimension, { fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .toBuffer();
    const prepared = await addPhotoCaption(resized, caption);
    const encoded = await encodeAtBestQuality(prepared);

    if (encoded.matching) return encoded.matching;

    const metadata = await sharp(resized).metadata();
    const actualDimension = Math.max(metadata.width ?? dimension, metadata.height ?? dimension);
    const targetRatio = Math.sqrt(MAX_PROCESSED_PHOTO_BYTES / encoded.smallest.length) * 0.92;
    const nextDimension = Math.floor(actualDimension * Math.min(0.85, targetRatio));
    dimension = Math.max(MIN_PHOTO_DIMENSION, Math.min(actualDimension - 1, nextDimension));
  }

  const fallbackSource = await sharp(sourceBuffer)
    .autoOrient()
    .resize(MIN_PHOTO_DIMENSION, MIN_PHOTO_DIMENSION, { fit: 'inside' })
    .flatten({ background: '#ffffff' })
    .toBuffer();
  const fallbackWithCaption = await addPhotoCaption(fallbackSource, caption);
  const fallback = await sharp(fallbackWithCaption)
    .jpeg({ quality: 20 })
    .toBuffer();

  if (fallback.length > MAX_PROCESSED_PHOTO_BYTES) {
    throw new Error('Processed photo could not be compressed below 200 KiB');
  }

  return fallback;
}

export async function processPhoto(
  sourceBuffer: Buffer,
  options: ProcessPhotoOptions = {},
): Promise<ProcessedPhoto> {
  let lat: number | null = null;
  let lng: number | null = null;
  let capturedAt: string | null = null;

  try {
    const exif = await exifr.parse(sourceBuffer, { gps: true, tiff: true, exif: true });
    lat = toFiniteNumber(exif?.latitude);
    lng = toFiniteNumber(exif?.longitude);
    capturedAt = normalizeCapturedAt(
      exif?.DateTimeOriginal ?? exif?.CreateDate ?? exif?.DateTimeDigitized ?? exif?.ModifyDate,
    );
  } catch {
    lat = null;
    lng = null;
    capturedAt = null;
  }

  capturedAt ??= normalizeCapturedAt(options.fallbackCapturedAt);

  const buffer = await compressPhoto(sourceBuffer, buildPhotoCaption({ capturedAt, lat, lng }));

  const thumbnail = await sharp(buffer)
    .resize(320, 240, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 80 })
    .toBuffer();

  return {
    buffer,
    thumbnail,
    mimeType: 'image/jpeg',
    lat,
    lng,
    capturedAt,
    fileSize: buffer.length,
  };
}
