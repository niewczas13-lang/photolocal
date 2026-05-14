import { describe, expect, it } from 'vitest';
import { runProjectOperation } from './project-operation-queue.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function flushAsyncWork(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('runProjectOperation', () => {
  it('runs operations for the same project one at a time', async () => {
    const firstGate = deferred();
    const events: string[] = [];

    const first = runProjectOperation('project-1', async () => {
      events.push('first:start');
      await firstGate.promise;
      events.push('first:end');
      return 'first';
    });
    const second = runProjectOperation('project-1', async () => {
      events.push('second:start');
      return 'second';
    });

    await flushAsyncWork();
    expect(events).toEqual(['first:start']);

    firstGate.resolve();

    await expect(first).resolves.toBe('first');
    await flushAsyncWork();
    await expect(second).resolves.toBe('second');
    expect(events).toEqual(['first:start', 'first:end', 'second:start']);
  });

  it('does not block another project', async () => {
    const firstGate = deferred();
    const events: string[] = [];

    const first = runProjectOperation('project-1', async () => {
      events.push('first:start');
      await firstGate.promise;
      events.push('first:end');
      return 'first';
    });
    const second = runProjectOperation('project-2', async () => {
      events.push('second:start');
      return 'second';
    });

    await expect(second).resolves.toBe('second');
    expect(events).toEqual(['first:start', 'second:start']);

    firstGate.resolve();
    await expect(first).resolves.toBe('first');
  });
});
