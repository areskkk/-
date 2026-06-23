import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  acquireTestLock,
  getPortListeners,
  killPortListeners,
  waitForPortToBeFree,
} from './db-test-utils.js';

const OCR_SIDECAR_PYTHON =
  'D:\\Desktop\\家助宝项目\\services\\ocr-service\\.venv\\Scripts\\python.exe';
const OCR_SIDECAR_CWD = 'D:\\Desktop\\家助宝项目\\services\\ocr-service';
const OCR_SIDECAR_PORT = 8015;
const OCR_LOG_DIR = path.resolve('.tmp/ocr-sidecar-logs');
export const OCR_TEST_INTERNAL_API_KEY = 'test-ocr-internal-key';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHttpHealth(baseUrl: string, timeoutMs = 120000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) {
        return;
      }
    } catch {
      // wait until healthy
    }
    await sleep(1000);
  }
  throw new Error(`ocr sidecar health check timeout for ${baseUrl}`);
}

export async function fetchOcrReady(baseUrl: string): Promise<{
  status: string;
  checks: Record<string, unknown>;
}> {
  const response = await fetch(`${baseUrl}/health/ready`);
  const body = await response.json() as {
    status: string;
    checks: Record<string, unknown>;
  };
  if (!response.ok) {
    throw new Error(`ocr sidecar ready failed ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

export class OcrSidecarTestManager {
  readonly port = OCR_SIDECAR_PORT;
  readonly baseUrl = `http://127.0.0.1:${OCR_SIDECAR_PORT}`;
  private sidecar: ChildProcess | null = null;
  private releaseLock: (() => Promise<void>) | null = null;
  private previousInternalApiKey: string | undefined;
  private previousExtraEnv: Record<string, string | undefined> = {};
  constructor(private readonly extraEnv: Record<string, string> = {}) {}

  async setupSuite(): Promise<void> {
    this.releaseLock = await acquireTestLock('ocr-sidecar-suite');
    await fs.promises.mkdir(OCR_LOG_DIR, { recursive: true });
    this.previousInternalApiKey = process.env.OCR_SERVICE_INTERNAL_API_KEY;
    this.previousExtraEnv = {};
    for (const key of Object.keys(this.extraEnv)) {
      this.previousExtraEnv[key] = process.env[key];
      process.env[key] = this.extraEnv[key];
    }
    process.env.OCR_SERVICE_INTERNAL_API_KEY = OCR_TEST_INTERNAL_API_KEY;
    await this.startSidecar();
  }

  async teardownSuite(): Promise<void> {
    await this.stopSidecar();
    if (this.previousInternalApiKey === undefined) {
      delete process.env.OCR_SERVICE_INTERNAL_API_KEY;
    } else {
      process.env.OCR_SERVICE_INTERNAL_API_KEY = this.previousInternalApiKey;
    }
    this.previousInternalApiKey = undefined;
    for (const [key, value] of Object.entries(this.previousExtraEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    this.previousExtraEnv = {};
    if (this.releaseLock) {
      await this.releaseLock();
      this.releaseLock = null;
    }
  }

  private async startSidecar(): Promise<void> {
    if (this.sidecar) {
      return;
    }

    killPortListeners(this.port);
    const stdoutPath = path.join(OCR_LOG_DIR, 'ocr-sidecar.stdout.log');
    const stderrPath = path.join(OCR_LOG_DIR, 'ocr-sidecar.stderr.log');
    await fs.promises.rm(stdoutPath, { force: true });
    await fs.promises.rm(stderrPath, { force: true });

    this.sidecar = spawn(
      OCR_SIDECAR_PYTHON,
      ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', String(this.port)],
      {
        cwd: OCR_SIDECAR_CWD,
        env: {
          ...process.env,
          OCR_PROVIDER_ENGINE: 'rapidocr',
          OCR_SERVICE_INTERNAL_API_KEY: OCR_TEST_INTERNAL_API_KEY,
          ...this.extraEnv,
        },
        stdio: [
          'ignore',
          fs.openSync(stdoutPath, 'a'),
          fs.openSync(stderrPath, 'a'),
        ],
      },
    );

    await waitForHttpHealth(this.baseUrl);
    await fetchOcrReady(this.baseUrl);
    if (getPortListeners(this.port).length === 0) {
      throw new Error(`ocr sidecar port ${this.port} is not listening after startup`);
    }
  }

  private async stopSidecar(): Promise<void> {
    if (!this.sidecar) {
      return;
    }

    this.sidecar.kill();
    this.sidecar = null;
    await sleep(1000);
    killPortListeners(this.port);
    await waitForPortToBeFree(this.port);
  }
}
