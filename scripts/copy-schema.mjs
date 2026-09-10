import { copyFile, mkdir } from 'node:fs/promises';

const source = new URL('../backend/src/db/schema.sql', import.meta.url);
const destinationDirectory = new URL('../backend/dist/db/', import.meta.url);
await mkdir(destinationDirectory, { recursive: true });
await copyFile(source, new URL('schema.sql', destinationDirectory));
