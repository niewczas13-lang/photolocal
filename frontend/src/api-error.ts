function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

export function parseApiErrorMessage(text: string, status: number): string {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const errorBody = parsed as Record<string, unknown>;
      if (nonEmptyString(errorBody.error)) return errorBody.error;
      if (nonEmptyString(errorBody.message)) return errorBody.message;
    }
  } catch {
    // Raw response bodies are handled below.
  }

  return text.trim() ? text : `HTTP ${status}`;
}
