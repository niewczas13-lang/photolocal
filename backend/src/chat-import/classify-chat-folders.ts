import { mkdir, readdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import {
  appendJsonLine,
  classifyChatFolder,
  parseModelList,
  type ChatFolderClassification,
} from './vision-classifier.js';

interface CliOptions {
  input: string;
  output: string;
  models: string[];
  ollamaUrl: string;
  limit: number | null;
  maxImages: number;
  imageMaxSize: number;
  skipNoDescription: boolean;
  requestTimeoutMs: number;
}

const DEFAULT_INPUT = '../pobierzchat/pobrane_zdjecia/Radom OPP13';
const DEFAULT_OUTPUT = '../pobierzchat/vision-classification-results.jsonl';

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const input = resolve(options.input);
  const output = resolve(options.output);
  const folders = await getFolderPaths(input, options.limit);

  await mkdir(dirname(output), { recursive: true });

  console.log(`Models: ${options.models.join(', ')}`);
  console.log(`Ollama: ${options.ollamaUrl}`);
  console.log(`Input: ${input}`);
  console.log(`Output: ${output}`);
  console.log(`Folders: ${folders.length}`);

  for (const model of options.models) {
    console.log(`\n=== ${model} ===`);

    for (const [index, folderPath] of folders.entries()) {
      const prefix = `[${index + 1}/${folders.length}]`;
      const folderName = folderPath.split(/[\\/]/).at(-1) ?? folderPath;
      console.log(`${prefix} ${folderName}`);

      if (options.skipNoDescription && isNoDescriptionFolder(folderName)) {
        const result = buildSkippedReviewResult(folderPath, model, 'Folder bez opisu z czatu.');
        await appendJsonLine(output, result);
        console.log('  -> SKIP review=true reason=brak_opisu');
        continue;
      }

      const startedAt = Date.now();
      try {
        const result = await classifyChatFolder({
          folderPath,
          model,
          ollamaUrl: options.ollamaUrl,
          maxImages: options.maxImages,
          imageMaxSize: options.imageMaxSize,
          requestTimeoutMs: options.requestTimeoutMs,
        });
        const durationMs = Date.now() - startedAt;
        const finalResult = applyFolderReviewRules({ ...result, durationMs }, folderName);
        await appendJsonLine(output, finalResult);
        console.log(
          `  -> ${finalResult.reserveLocation} confidence=${finalResult.confidence.toFixed(2)} review=${finalResult.shouldReview} time=${(durationMs / 1000).toFixed(1)}s`,
        );
      } catch (error) {
        const result = buildErrorResult(folderPath, model, error, Date.now() - startedAt);
        await appendJsonLine(output, result);
        console.log(
          `  -> ERROR review=true time=${((Date.now() - startedAt) / 1000).toFixed(1)}s ${result.error}`,
        );
      }
    }
  }
}

async function getFolderPaths(input: string, limit: number | null): Promise<string[]> {
  const inputStat = await stat(input);
  if (!inputStat.isDirectory()) {
    throw new Error(`Input is not a directory: ${input}`);
  }

  const entries = await readdir(input, { withFileTypes: true });
  const folders = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(input, entry.name))
    .sort((a, b) => a.localeCompare(b, 'pl'));

  if (folders.length === 0) {
    return [input];
  }

  return typeof limit === 'number' ? folders.slice(0, limit) : folders;
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    input: DEFAULT_INPUT,
    output: DEFAULT_OUTPUT,
    models: parseModelList(
      process.env.OLLAMA_VISION_MODELS,
      process.env.OLLAMA_VISION_MODEL ?? 'qwen2.5vl:3b',
    ),
    ollamaUrl: process.env.OLLAMA_URL ?? 'http://localhost:11434',
    limit: 10,
    maxImages: 5,
    imageMaxSize: 1024,
    skipNoDescription: true,
    requestTimeoutMs: 60_000,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];

    if (arg === '--input' && next) {
      options.input = next;
      index += 1;
    } else if (arg === '--output' && next) {
      options.output = next;
      index += 1;
    } else if (arg === '--model' && next) {
      options.models = [next];
      index += 1;
    } else if (arg === '--models' && next) {
      options.models = parseModelList(next, 'qwen2.5vl:3b');
      index += 1;
    } else if (arg === '--ollama-url' && next) {
      options.ollamaUrl = next;
      index += 1;
    } else if (arg === '--limit' && next) {
      options.limit = next.toLowerCase() === 'all' ? null : parsePositiveInt(next, '--limit');
      index += 1;
    } else if (arg === '--max-images' && next) {
      options.maxImages = parsePositiveInt(next, '--max-images');
      index += 1;
    } else if (arg === '--image-max-size' && next) {
      options.imageMaxSize = parsePositiveInt(next, '--image-max-size');
      index += 1;
    } else if (arg === '--request-timeout-ms' && next) {
      options.requestTimeoutMs = parsePositiveInt(next, '--request-timeout-ms');
      index += 1;
    } else if (arg === '--include-no-description') {
      options.skipNoDescription = false;
    } else if (arg === '--help') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  return options;
}

function parsePositiveInt(value: string, name: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function isNoDescriptionFolder(folderName: string): boolean {
  return /(^|_)brak_opisu$/i.test(folderName.trim());
}

function applyFolderReviewRules(
  result: ChatFolderClassification,
  folderName: string,
): ChatFolderClassification {
  if (!hasLikelyMultipleAddresses(folderName)) {
    return result;
  }

  const reason = result.reason
    ? `${result.reason} Folder wyglada na wieloadresowy, wiec wymaga review.`
    : 'Folder wyglada na wieloadresowy, wiec wymaga review.';

  return {
    ...result,
    reason,
    shouldReview: true,
  };
}

function hasLikelyMultipleAddresses(folderName: string): boolean {
  const withoutDate = folderName.replace(/^\d{4}-\d{2}-\d{2}_/, '');
  return /\b\d+[A-Z]?\s*(?:i|oraz)\s*\d+[A-Z]?\b/i.test(withoutDate);
}

function buildSkippedReviewResult(
  folderPath: string,
  model: string,
  reason: string,
): ChatFolderClassification {
  return {
    folder: folderPath.split(/[\\/]/).at(-1) ?? folderPath,
    imageCount: 0,
    sampledImages: [],
    model,
    durationMs: 0,
    classifiedAt: new Date().toISOString(),
    reserveLocation: 'Niepewne',
    confidence: 0,
    visualEvidence: [],
    reason,
    shouldReview: true,
  };
}

function buildErrorResult(
  folderPath: string,
  model: string,
  error: unknown,
  durationMs?: number,
): ChatFolderClassification {
  return {
    folder: folderPath.split(/[\\/]/).at(-1) ?? folderPath,
    imageCount: 0,
    sampledImages: [],
    model,
    durationMs,
    classifiedAt: new Date().toISOString(),
    reserveLocation: 'Niepewne',
    confidence: 0,
    visualEvidence: [],
    reason: 'Klasyfikacja nie powiodla sie.',
    shouldReview: true,
    error: error instanceof Error ? error.message : String(error),
  };
}

function printHelp(): void {
  console.log(`Usage:
  npm run classify:chat --workspace backend -- [options]

Options:
  --input <path>            Folder with Google Chat message folders
  --output <path>           JSONL output path
  --model <name>            Ollama model, default qwen2.5vl:3b
  --models <a,b,c>          Run the same folders through multiple models
  --ollama-url <url>        Default http://localhost:11434
  --limit <n|all>           Default 10
  --max-images <n>          Images sampled per folder, default 5
  --image-max-size <px>     Resize before Ollama, default 1024
  --request-timeout-ms <n>  Ollama request timeout, default 60000
  --include-no-description  Classify brak_opisu folders instead of sending to review
`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
