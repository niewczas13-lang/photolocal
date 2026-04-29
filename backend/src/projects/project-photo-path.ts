import { join, resolve } from 'node:path';

const PROJECT_PHOTOS_FOLDER_NAME = 'zdjecia';

export function resolveProjectPhotoFolder(photoRootPath: string): string {
  const trimmed = photoRootPath.trim();
  if (!trimmed) {
    throw new Error('photoRootPath is required');
  }

  return join(resolve(trimmed), PROJECT_PHOTOS_FOLDER_NAME);
}
