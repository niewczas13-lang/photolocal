import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import {
  buildPhotoCaption,
  buildReservePhotoName,
  processPhoto,
  resolvePhotoTarget,
} from './photo-processor.js';

async function createDetailedPhoto(): Promise<Buffer> {
  const width = 1800;
  const height = 1200;
  const pixels = Buffer.alloc(width * height * 3);
  let state = 0x12345678;

  for (let index = 0; index < pixels.length; index += 1) {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    pixels[index] = state >>> 24;
  }

  return sharp(pixels, { raw: { width, height, channels: 3 } })
    .jpeg({ quality: 95 })
    .toBuffer();
}

function averageRowBrightness(data: Buffer, width: number, channels: number, row: number): number {
  let total = 0;
  for (let column = 0; column < width; column += 1) {
    const offset = (row * width + column) * channels;
    total += data[offset] + data[offset + 1] + data[offset + 2];
  }
  return total / (width * 3);
}

async function createExifPhoto(exif: Record<string, Record<string, string>>): Promise<Buffer> {
  return sharp({ create: { width: 160, height: 120, channels: 3, background: '#ffffff' } })
    .jpeg().withExif(exif).toBuffer();
}

describe('photo processor naming', () => {
  it('names underground reserve photos by address and index', () => {
    expect(buildReservePhotoName('WRONCKIEJ_13', 3)).toBe('WRONCKIEJ_13_foto3.jpeg');
  });

  it('routes underground reserve photos into doziemne folder', () => {
    const target = resolvePhotoTarget({
      projectFolder: 'D:/Baza/PROJEKT',
      nodePath: 'Zapasy_kabli_instalacyjnych/OSD2640/WRONCKIEJ_13',
      nodeName: 'WRONCKIEJ_13',
      existingCount: 0,
      reserveLocation: 'Doziemny',
      sourceFileName: 'IMG_001.jpg',
    });

    expect(target.relativeFolder).toBe('Zapasy_kabli_instalacyjnych/Zapasy_doziemne/WRONCKIEJ_13');
    expect(target.fileName).toBe('WRONCKIEJ_13_foto1.jpeg');
  });

  it('routes aerial reserve photos into napowietrzne folder', () => {
    const target = resolvePhotoTarget({
      projectFolder: 'D:/Baza/PROJEKT',
      nodePath: 'Zapasy_kabli_napowietrznych/OSD2640/WRONCKIEJ_13',
      nodeName: 'WRONCKIEJ_13',
      existingCount: 1,
      reserveLocation: 'Napowietrzny',
      sourceFileName: 'IMG_002.jpg',
    });

    expect(target.relativeFolder).toBe('Zapasy_kabli_napowietrznych/Zapasy_napowietrzne/WRONCKIEJ_13');
    expect(target.fileName).toBe('WRONCKIEJ_13_foto2.jpeg');
  });

  it('keeps processed photos at or below 200 KiB', async () => {
    const processed = await processPhoto(await createDetailedPhoto(), {
      fallbackCapturedAt: '2026-08-13T12:30:45.000Z',
    });

    expect(processed.fileSize).toBe(processed.buffer.length);
    expect(processed.buffer.length).toBeLessThanOrEqual(200 * 1024);
  });

  it('formats only the metadata values that are available', () => {
    expect(buildPhotoCaption({
      capturedAt: '2026-08-13T12:30:45.000Z',
      lat: null,
      lng: null,
    })).toBe('Data: 13.08.2026 14:30:45');
    expect(buildPhotoCaption({
      capturedAt: '2026-08-13T12:30:45.000Z',
      lat: 53.76778,
      lng: 20.5377,
    })).toBe('Data: 13.08.2026 14:30:45 | GPS: 53.767780, 20.537700');
  });

  it('uses a fallback date and burns its caption into the bottom of the photo', async () => {
    const source = await sharp({
      create: {
        width: 800,
        height: 600,
        channels: 3,
        background: '#ffffff',
      },
    }).jpeg().toBuffer();
    const processed = await processPhoto(source, {
      fallbackCapturedAt: '2026-08-13T12:30:45.000Z',
    });
    const decoded = await sharp(processed.buffer).raw().toBuffer({ resolveWithObject: true });
    const topBrightness = averageRowBrightness(decoded.data, decoded.info.width, decoded.info.channels, 20);
    const bottomBrightness = averageRowBrightness(
      decoded.data,
      decoded.info.width,
      decoded.info.channels,
      decoded.info.height - 5,
    );

    expect(processed.capturedAt).toBe('2026-08-13T12:30:45.000Z');
    expect(bottomBrightness).toBeLessThan(topBrightness - 80);
    expect(processed.buffer.length).toBeLessThanOrEqual(200 * 1024);
  });

  it('reads the original capture date and GPS coordinates from EXIF', async () => {
    const source = await sharp({
      create: {
        width: 800,
        height: 600,
        channels: 3,
        background: '#ffffff',
      },
    })
      .jpeg()
      .withExif({
        IFD2: {
          DateTimeOriginal: '2026:08:13 12:30:45',
          OffsetTimeOriginal: '+02:00',
        },
        IFD3: {
          GPSLatitudeRef: 'N',
          GPSLatitude: '53/1 46/1 4008/1000',
          GPSLongitudeRef: 'E',
          GPSLongitude: '20/1 32/1 15720/1000',
        },
      })
      .toBuffer();
    const processed = await processPhoto(source, {
      fallbackCapturedAt: '2026-08-10T08:00:00.000Z',
    });

    expect(processed.capturedAt).toBe('2026-08-13T10:30:45.000Z');
    expect(processed.lat).toBeCloseTo(53.76778, 5);
    expect(processed.lng).toBeCloseTo(20.5377, 5);
    expect(buildPhotoCaption(processed)).toBe(
      'Data: 13.08.2026 12:30:45 | GPS: 53.767780, 20.537700',
    );
  });

  it.each([
    ['2026:08:13 12:30:45', '+05:30', '2026-08-13T07:00:45.000Z'],
    ['2026:03:29 01:30:00', '+01:00', '2026-03-29T00:30:00.000Z'],
    ['2026:03:29 03:30:00', '+02:00', '2026-03-29T01:30:00.000Z'],
    ['2026:10:25 02:30:00', '+02:00', '2026-10-25T00:30:00.000Z'],
    ['2026:10:25 02:30:00', '+01:00', '2026-10-25T01:30:00.000Z'],
  ])('honors EXIF offset %s %s independently of host timezone', async (date, offset, expected) => {
    const processed = await processPhoto(await createExifPhoto({
      IFD2: { DateTimeOriginal: date, OffsetTimeOriginal: offset },
    }));
    expect(processed.capturedAt).toBe(expected);
  });

  it('uses the digitized date with its own negative offset', async () => {
    const processed = await processPhoto(await createExifPhoto({
      IFD2: { DateTimeDigitized: '2026:08:13 12:30:45', OffsetTimeDigitized: '-04:00' },
    }));
    expect(processed.capturedAt).toBe('2026-08-13T16:30:45.000Z');
  });

  it.each([
    ['2026:08:13 12:30:45', '+XX:YY'],
    ['2026:08:13 12:30:45', '+25:00'],
    ['not-a-date', '+02:00'],
  ])('uses fallback instead of invalid EXIF date/offset %s %s', async (date, offset) => {
    const fallbackCapturedAt = '2026-08-10T08:00:00.000Z';
    const processed = await processPhoto(await createExifPhoto({
      IFD2: { DateTimeOriginal: date, OffsetTimeOriginal: offset },
    }), { fallbackCapturedAt });
    expect(processed.capturedAt).toBe(fallbackCapturedAt);
  });

  it.each([
    ['2026:08:13 12:30:45', 7],
    ['2026:01:13 12:30:45', 0],
  ] as const)('retains local-time interpretation for offsetless EXIF %s', async (date, month) => {
    const processed = await processPhoto(await createExifPhoto({ IFD2: { DateTimeOriginal: date } }));
    // Legacy Windows behavior: missing EXIF offset means the configured server timezone.
    // Docker defaults to Europe/Warsaw, including its summer/winter offset changes.
    expect(processed.capturedAt).toBe(new Date(2026, month, 13, 12, 30, 45).toISOString());
  });
});
