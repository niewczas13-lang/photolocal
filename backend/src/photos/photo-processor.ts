import exifr from 'exifr';
import { extname, join } from 'node:path';
import sharp from 'sharp';
import { safeFolderName } from '../utils/path-names.js';

export type ReserveLocation = 'Doziemny' | 'W studni';

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

export function buildReservePhotoName(addressName: string, index: number): string {
  return `${safeFolderName(addressName)}_foto${index}.jpeg`;
}

export function resolvePhotoTarget(input: ResolvePhotoTargetInput): PhotoTarget {
  if (input.nodePath.startsWith('Zapasy_kabli_instalacyjnych') && input.reserveLocation) {
    const installType = input.reserveLocation === 'Doziemny' ? 'Zapasy_doziemne' : 'Zapasy_w_studni';
    const addressName = safeFolderName(input.nodeName);
    const relativeFolder = `Zapasy_kabli_instalacyjnych/${installType}/${addressName}`;
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

export async function processPhoto(sourceBuffer: Buffer): Promise<ProcessedPhoto> {
  let lat: number | null = null;
  let lng: number | null = null;
  let capturedAt: string | null = null;

  try {
    const exif = await exifr.parse(sourceBuffer, { gps: true, tiff: true, exif: true });
    lat = exif?.latitude ?? null;
    lng = exif?.longitude ?? null;
    capturedAt = exif?.DateTimeOriginal ? new Date(exif.DateTimeOriginal).toISOString() : null;
  } catch {
    lat = null;
    lng = null;
    capturedAt = null;
  }

  const buffer = await sharp(sourceBuffer)
    .resize(2048, 2048, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 82 })
    .toBuffer();

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
