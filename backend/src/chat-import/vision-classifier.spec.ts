import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  classifyChatFolder,
  decideReviewStatus,
  getDefaultVisionModel,
  parseModelList,
  parseVisionClassification,
  type VisionClassification,
} from './vision-classifier.js';

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.OLLAMA_VISION_MODEL;
});

describe('parseVisionClassification', () => {
  it('parses a plain JSON model response', () => {
    const result = parseVisionClassification(`{
      "reserveLocation": "W studni",
      "confidence": 0.91,
      "visualEvidence": ["widoczna komora studni", "zapas kabla wewnatrz"],
      "reason": "Zdjecia pokazuja zapas w studni."
    }`);

    expect(result).toEqual({
      reserveLocation: 'W studni',
      confidence: 0.91,
      visualEvidence: ['widoczna komora studni', 'zapas kabla wewnatrz'],
      reason: 'Zdjecia pokazuja zapas w studni.',
      shouldReview: false,
    });
  });

  it('parses JSON wrapped in a markdown fence', () => {
    const result = parseVisionClassification(`Here is the result:
\`\`\`json
{
  "reserveLocation": "Doziemny",
  "confidence": 0.87,
  "visualEvidence": ["kabel lezy w wykopie"],
  "shouldReview": false
}
\`\`\``);

    expect(result.reserveLocation).toBe('Doziemny');
    expect(result.confidence).toBe(0.87);
    expect(result.shouldReview).toBe(false);
  });

  it('extracts visual evidence descriptions from object arrays', () => {
    const result = parseVisionClassification(`{
      "reserveLocation": "W studni",
      "confidence": 0.88,
      "visualEvidence": [
        { "description": "widoczne sciany studni" },
        { "description": "kabel lezy na dnie komory" }
      ]
    }`);

    expect(result.visualEvidence).toEqual([
      'widoczne sciany studni',
      'kabel lezy na dnie komory',
    ]);
  });

  it('forces review for unknown labels', () => {
    const result = parseVisionClassification(`{
      "reserveLocation": "studzienka",
      "confidence": 0.99,
      "visualEvidence": []
    }`);

    expect(result.reserveLocation).toBe('Niepewne');
    expect(result.shouldReview).toBe(true);
  });
});

describe('getDefaultVisionModel', () => {
  it('uses OLLAMA_VISION_MODEL when it is set', () => {
    process.env.OLLAMA_VISION_MODEL = 'qwen3-vl:8b';

    expect(getDefaultVisionModel()).toBe('qwen3-vl:8b');
  });
});

describe('classifyChatFolder', () => {
  it('retries a degenerate Ollama response with a lighter request', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'photo-local-vision-retry-'));
    writeFileSync(
      join(dir, 'photo.png'),
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
        'base64',
      ),
    );
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: { content: '{"!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!' } }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ done: true }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            message: {
              content:
                '{"reserveLocation":"Doziemny","confidence":0.92,"visualEvidence":["kabel w wykopie"],"shouldReview":false}',
            },
          }),
          { status: 200 },
        ),
      );

    const result = await classifyChatFolder({
      folderPath: dir,
      ollamaUrl: 'http://ollama.test',
      requestTimeoutMs: 10_000,
    });

    expect(result).toMatchObject({
      reserveLocation: 'Doziemny',
      confidence: 0.92,
      shouldReview: false,
      visualEvidence: ['kabel w wykopie'],
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[1][0])).toBe('http://ollama.test/api/generate');
  });
});

describe('decideReviewStatus', () => {
  it('keeps confident reserve classifications out of review when the model does not request review', () => {
    const classification: VisionClassification = {
      reserveLocation: 'Doziemny',
      confidence: 0.9,
      visualEvidence: ['zapas kabla w ziemi'],
      reason: 'Widoczny wykop.',
      shouldReview: false,
    };

    expect(decideReviewStatus(classification)).toEqual({
      ...classification,
      shouldReview: false,
    });
  });

  it('keeps review when the model requests it', () => {
    const classification: VisionClassification = {
      reserveLocation: 'Doziemny',
      confidence: 0.9,
      visualEvidence: ['zapas kabla w ziemi'],
      reason: 'Model widzi cos niejednoznacznego.',
      shouldReview: true,
    };

    expect(decideReviewStatus(classification)).toEqual({
      ...classification,
      shouldReview: true,
    });
  });

  it('requires review below the confidence threshold', () => {
    const classification: VisionClassification = {
      reserveLocation: 'W studni',
      confidence: 0.84,
      visualEvidence: ['mozliwa studnia'],
      shouldReview: false,
    };

    expect(decideReviewStatus(classification)).toEqual({
      ...classification,
      shouldReview: true,
    });
  });
});

describe('model requested review parsing', () => {
  it('ignores model shouldReview when label and confidence pass local rules', () => {
    const result = parseVisionClassification(`{
      "reserveLocation": "Doziemny",
      "confidence": 0.9,
      "visualEvidence": ["kabel w wykopie"],
      "shouldReview": true
    }`);

    expect(result).toMatchObject({
      reserveLocation: 'Doziemny',
      confidence: 0.9,
      shouldReview: false,
    });
  });
});

describe('parseModelList', () => {
  it('parses comma-separated model names', () => {
    expect(parseModelList('moondream, llava:7b, qwen2.5vl:3b', 'qwen2.5vl:3b')).toEqual([
      'moondream',
      'llava:7b',
      'qwen2.5vl:3b',
    ]);
  });

  it('falls back to the default model when the list is empty', () => {
    expect(parseModelList(' , ', 'qwen2.5vl:3b')).toEqual(['qwen2.5vl:3b']);
  });
});
