const queues = new Map<string, Promise<unknown>>();

export async function runProjectOperation<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
  const previous = queues.get(projectId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current, () => current);

  queues.set(projectId, tail);

  await previous.catch(() => undefined);

  try {
    return await operation();
  } finally {
    release();
    if (queues.get(projectId) === tail) {
      queues.delete(projectId);
    }
  }
}
