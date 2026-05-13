import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { getDefaultVisionModel } from './vision-classifier.js';

const execFileAsync = promisify(execFile);
const DEFAULT_OLLAMA_URL = 'http://localhost:11434';

export interface OllamaDiagnostics {
  checkedAt: string;
  ollamaUrl: string;
  model: string;
  ollamaReachable: boolean;
  modelLoaded: boolean;
  processor: string | null;
  size: string | null;
  sizeVram: string | null;
  expiresAt: string | null;
  gpu: NvidiaSmiSnapshot | null;
  error: string | null;
}

export interface NvidiaSmiSnapshot {
  name: string;
  utilizationGpuPercent: number | null;
  memoryUsedMiB: number | null;
  memoryTotalMiB: number | null;
  temperatureC: number | null;
}

interface OllamaPsModel {
  name?: unknown;
  model?: unknown;
  size?: unknown;
  size_vram?: unknown;
  processor?: unknown;
  expires_at?: unknown;
}

interface OllamaPsResponse {
  models?: unknown;
}

export async function getOllamaDiagnostics(): Promise<OllamaDiagnostics> {
  const ollamaUrl = process.env.OLLAMA_URL?.trim() || DEFAULT_OLLAMA_URL;
  const model = getDefaultVisionModel();
  const [ollama, gpu] = await Promise.all([readOllamaPs(ollamaUrl, model), readNvidiaSmi()]);

  return {
    checkedAt: new Date().toISOString(),
    ollamaUrl,
    model,
    ollamaReachable: ollama.reachable,
    modelLoaded: Boolean(ollama.model),
    processor: ollama.processor,
    size: formatBytes(ollama.size),
    sizeVram: formatBytes(ollama.sizeVram),
    expiresAt: ollama.expiresAt,
    gpu,
    error: ollama.error,
  };
}

async function readOllamaPs(
  ollamaUrl: string,
  expectedModel: string,
): Promise<{
  reachable: boolean;
  model: OllamaPsModel | null;
  processor: string | null;
  size: number | null;
  sizeVram: number | null;
  expiresAt: string | null;
  error: string | null;
}> {
  try {
    const response = await fetch(`${ollamaUrl.replace(/\/$/, '')}/api/ps`, {
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) {
      return emptyOllama(false, `Ollama /api/ps HTTP ${response.status}`);
    }

    const payload = (await response.json()) as OllamaPsResponse;
    const models = Array.isArray(payload.models) ? (payload.models as OllamaPsModel[]) : [];
    const model =
      models.find((item) => modelName(item).toLowerCase() === expectedModel.toLowerCase()) ??
      models.find((item) => modelName(item).toLowerCase().startsWith(expectedModel.toLowerCase())) ??
      null;

    if (!model) {
      return emptyOllama(true, null);
    }

    const sizeVram = numberOrNull(model.size_vram);
    const processor = stringOrNull(model.processor) ?? (sizeVram && sizeVram > 0 ? 'GPU/VRAM' : null);

    return {
      reachable: true,
      model,
      processor,
      size: numberOrNull(model.size),
      sizeVram,
      expiresAt: stringOrNull(model.expires_at),
      error: null,
    };
  } catch (error) {
    return emptyOllama(false, error instanceof Error ? error.message : String(error));
  }
}

function emptyOllama(reachable: boolean, error: string | null) {
  return {
    reachable,
    model: null,
    processor: null,
    size: null,
    sizeVram: null,
    expiresAt: null,
    error,
  };
}

async function readNvidiaSmi(): Promise<NvidiaSmiSnapshot | null> {
  try {
    const { stdout } = await execFileAsync(
      'nvidia-smi',
      [
        '--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu',
        '--format=csv,noheader,nounits',
      ],
      { timeout: 2_000, windowsHide: true },
    );
    const line = stdout.split(/\r?\n/).find((item) => item.trim());
    if (!line) return null;

    const [name, utilizationGpu, memoryUsed, memoryTotal, temperature] = line
      .split(',')
      .map((item) => item.trim());

    return {
      name,
      utilizationGpuPercent: numberFromString(utilizationGpu),
      memoryUsedMiB: numberFromString(memoryUsed),
      memoryTotalMiB: numberFromString(memoryTotal),
      temperatureC: numberFromString(temperature),
    };
  } catch {
    return null;
  }
}

function modelName(model: OllamaPsModel): string {
  return stringOrNull(model.name) ?? stringOrNull(model.model) ?? '';
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function numberFromString(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatBytes(value: number | null): string | null {
  if (value === null) return null;
  const gib = value / 1024 / 1024 / 1024;
  if (gib >= 1) return `${gib.toFixed(1)} GB`;
  const mib = value / 1024 / 1024;
  return `${mib.toFixed(0)} MB`;
}
