import { copyFile, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export class LocalStorage {
  constructor(private readonly basePath: string) {}

  resolvePath(relativePath: string): string {
    const base = resolve(this.basePath);
    const resolved = resolve(base, relativePath.replace(/\\/g, '/'));
    if (resolved !== base && !resolved.startsWith(base + '\\') && !resolved.startsWith(base + '/')) {
      throw new Error('Invalid storage path');
    }
    return resolved;
  }

  async write(relativePath: string, body: Buffer): Promise<string> {
    const target = this.resolvePath(relativePath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, body);
    return target;
  }

  async copy(relativePath: string, sourcePath: string): Promise<string> {
    const target = this.resolvePath(relativePath);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(sourcePath, target);
    return target;
  }

  async read(relativePath: string): Promise<Buffer> {
    return readFile(this.resolvePath(relativePath));
  }

  async delete(relativePath: string): Promise<void> {
    await unlink(this.resolvePath(relativePath));
  }
}
