import { describe, expect, it } from 'vitest';

import { parseApiErrorMessage } from './api-error';

describe('parseApiErrorMessage', () => {
  it('prefers a JSON error string over a JSON message string', () => {
    expect(parseApiErrorMessage('{"error":"Qwen nie odpowiada","message":"Blad raportu"}', 502)).toBe(
      'Qwen nie odpowiada',
    );
  });

  it('uses a JSON message string when error is not a string', () => {
    expect(parseApiErrorMessage('{"error":{"code":"FAILED"},"message":"Blad raportu"}', 500)).toBe(
      'Blad raportu',
    );
  });

  it('keeps a raw non-empty response body', () => {
    expect(parseApiErrorMessage('Serwer raportow jest niedostepny', 503)).toBe(
      'Serwer raportow jest niedostepny',
    );
  });

  it('falls back to the HTTP status for an empty response body', () => {
    expect(parseApiErrorMessage('   ', 504)).toBe('HTTP 504');
  });
});
