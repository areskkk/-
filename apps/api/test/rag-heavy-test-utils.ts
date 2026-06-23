import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import {
  acquireTestLock,
  getPortListeners,
  killPortListeners,
  truncateBusinessTables,
  waitForPortToBeFree,
} from './db-test-utils.js';

const { Client } = pg;

const SIDECAR_PYTHON =
  'D:\\Desktop\\家助宝项目\\services\\rag-service\\.venv\\Scripts\\python.exe';
const SIDECAR_CWD = 'D:\\Desktop\\家助宝项目\\services\\rag-service';
const APP_DATABASE_URL = 'postgresql://postgres:postgres@127.0.0.1:5432/nankang_zhuqibao';
const PGVECTOR_DATABASE_URL = 'postgresql://postgres@127.0.0.1:55432/nankang_zhuqibao';
const READONLY_APP_DATABASE_URL =
  'postgresql://rag_readonly_test:rag_readonly_test@127.0.0.1:5432/nankang_zhuqibao';

const DOCKER_CONTAINER_NAME = 'nankang-pgvector';
const DOCKER_IMAGE = 'pgvector/pgvector:pg16';
const DOCKER_PORT = 55432;
const PGVECTOR_TABLE_NAME = 'haystack_policy_documents';
const LOG_DIR = path.resolve('.tmp/rag-heavy-logs');
const READONLY_APP_TABLES = [
  'policies',
  'policy_chunks',
  'policy_ai_whitelist',
] as const;
type ReadonlyAppTable = typeof READONLY_APP_TABLES[number];
const READONLY_WRITE_PROBE_SQL_BY_TABLE: Record<ReadonlyAppTable, string> = {
  policies: `
    INSERT INTO policies (
      title,
      source_type,
      source_name,
      status,
      version,
      content
    )
    VALUES (
      'readonly write probe',
      'manual_import',
      'readonly probe',
      'effective',
      'v1',
      'should fail'
    )
  `,
  policy_chunks: `
    INSERT INTO policy_chunks (
      policy_id,
      version,
      title,
      section_path,
      chunk_order,
      content,
      content_hash,
      status,
      metadata
    )
    VALUES (
      gen_random_uuid(),
      'v1',
      'readonly write probe',
      'readonly probe',
      987654321,
      'should fail',
      'readonly-write-probe',
      'effective',
      '{}'::jsonb
    )
  `,
  policy_ai_whitelist: `
    INSERT INTO policy_ai_whitelist (
      policy_id,
      enabled
    )
    VALUES (
      gen_random_uuid(),
      true
    )
  `,
};

export type RagHeavyBackend = 'haystack_inmemory' | 'haystack_pgvector';
export type RagHeavySuiteName = 'batch10' | 'batch11b' | 'rag-eval';

const SUITE_PORTS: Record<RagHeavySuiteName, number> = {
  batch10: 8010,
  batch11b: 8012,
  'rag-eval': 8013,
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowMs(): number {
  return Date.now();
}

function execDocker(args: string[]): string {
  const result = spawnSync('docker', args, { encoding: 'utf-8' });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `docker ${args.join(' ')} failed`);
  }
  return result.stdout ?? '';
}

export async function fetchRagReady(baseUrl: string): Promise<{
  status: string;
  checks: Record<string, unknown>;
}> {
  const response = await fetch(`${baseUrl}/health/ready`);
  const body = await response.json() as {
    status: string;
    checks: Record<string, unknown>;
  };
  if (!response.ok) {
    throw new Error(`sidecar ready failed ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

async function waitForHttpReady(
  baseUrl: string,
  expectedBackend: RagHeavyBackend,
  timeoutMs = 120000,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const body = await fetchRagReady(baseUrl);
      if (body.checks.backend_mode === expectedBackend) {
        return;
      }
    } catch {
      // wait until healthy
    }
    await sleep(1000);
  }
  throw new Error(`sidecar ready check timeout for ${baseUrl}`);
}

export async function ensureReadonlyRagAppUser(): Promise<void> {
  const client = new Client({ connectionString: APP_DATABASE_URL });
  await client.connect();
  try {
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_roles
          WHERE rolname = 'rag_readonly_test'
        ) THEN
          CREATE ROLE rag_readonly_test LOGIN PASSWORD 'rag_readonly_test';
        ELSE
          ALTER ROLE rag_readonly_test WITH LOGIN PASSWORD 'rag_readonly_test';
        END IF;
      END $$;
    `);
    await client.query('REVOKE ALL ON SCHEMA public FROM rag_readonly_test');
    await client.query('GRANT USAGE ON SCHEMA public TO rag_readonly_test');
    for (const tableName of READONLY_APP_TABLES) {
      await client.query(`REVOKE ALL PRIVILEGES ON TABLE ${tableName} FROM rag_readonly_test`);
      await client.query(`GRANT SELECT ON TABLE ${tableName} TO rag_readonly_test`);
    }
  } finally {
    await client.end();
  }
}

export async function assertReadonlyRagAppUserCannotWriteBusinessTables(): Promise<void> {
  const client = new Client({ connectionString: READONLY_APP_DATABASE_URL });
  await client.connect();
  try {
    for (const tableName of READONLY_APP_TABLES) {
      let blocked = false;
      try {
        await client.query('BEGIN');
        await client.query(READONLY_WRITE_PROBE_SQL_BY_TABLE[tableName]);
      } catch (error) {
        blocked = ['42501', '25006'].includes(String((error as { code?: unknown }).code));
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
      }
      if (!blocked) {
        throw new Error(`rag_readonly_test unexpectedly wrote to ${tableName}`);
      }
    }
  } finally {
    await client.end();
  }
}

async function waitForDatabaseReady(connectionString: string, timeoutMs = 120000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const client = new Client({ connectionString });
    try {
      await client.connect();
      await client.query('SELECT current_database()');
      return;
    } catch {
      await sleep(1000);
    } finally {
      await client.end().catch(() => undefined);
    }
  }
  throw new Error(`database readiness timeout for ${connectionString}`);
}

async function assertVectorExtension(connectionString: string): Promise<void> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query('CREATE EXTENSION IF NOT EXISTS vector');
    const result = await client.query(
      "SELECT extname FROM pg_extension WHERE extname = 'vector'",
    );
    if (result.rows.length === 0) {
      throw new Error('vector extension is not available in target database');
    }
  } finally {
    await client.end();
  }
}

async function clearPgvectorTable(connectionString: string): Promise<void> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query(`CREATE EXTENSION IF NOT EXISTS vector`);
    await client.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM information_schema.tables
          WHERE table_schema = 'public'
            AND table_name = '${PGVECTOR_TABLE_NAME}'
        ) THEN
          EXECUTE 'TRUNCATE TABLE public.${PGVECTOR_TABLE_NAME}';
        END IF;
      END $$;
    `);
  } finally {
    await client.end();
  }
}

async function ensurePgvectorContainer(): Promise<void> {
  const startedAt = nowMs();
  try {
    execDocker(['version']);
  } catch (error) {
    throw new Error(`docker daemon is not available: ${(error as Error).message}`);
  }

  const listOutput = execDocker([
    'ps',
    '-a',
    '--filter',
    `name=${DOCKER_CONTAINER_NAME}`,
    '--format',
    '{{.Names}} {{.Status}}',
  ]).trim();

  if (listOutput === '') {
    execDocker([
      'run',
      '-d',
      '--name',
      DOCKER_CONTAINER_NAME,
      '-e',
      'POSTGRES_HOST_AUTH_METHOD=trust',
      '-e',
      'POSTGRES_DB=nankang_zhuqibao',
      '-p',
      `${DOCKER_PORT}:5432`,
      DOCKER_IMAGE,
    ]);
  } else if (!listOutput.toLowerCase().includes('up')) {
    execDocker(['start', DOCKER_CONTAINER_NAME]);
  }

  await waitForDatabaseReady(PGVECTOR_DATABASE_URL);
  await assertVectorExtension(PGVECTOR_DATABASE_URL);
  console.log(`rag-heavy:${DOCKER_CONTAINER_NAME}:ready_ms=${nowMs() - startedAt}`);
}

export class RagHeavyTestManager {
  readonly suiteName: RagHeavySuiteName;
  readonly backend: RagHeavyBackend;
  private appDatabaseUrl: string;
  readonly port: number;
  readonly baseUrl: string;
  private sidecar: ChildProcess | null = null;
  private releaseSuiteLock: (() => Promise<void>) | null = null;

  constructor(input: {
    suiteName: RagHeavySuiteName;
    backend: RagHeavyBackend;
    appDatabaseUrl?: string;
  }) {
    this.suiteName = input.suiteName;
    this.backend = input.backend;
    this.appDatabaseUrl = input.appDatabaseUrl
      ?? (input.backend === 'haystack_pgvector' ? READONLY_APP_DATABASE_URL : APP_DATABASE_URL);
    this.port = SUITE_PORTS[input.suiteName];
    this.baseUrl = `http://127.0.0.1:${this.port}`;
  }

  async setupSuite(): Promise<void> {
    const startedAt = nowMs();
    this.releaseSuiteLock = await acquireTestLock('rag-heavy-suite');
    await fs.promises.mkdir(LOG_DIR, { recursive: true });
    if (this.backend === 'haystack_pgvector') {
      await ensurePgvectorContainer();
      await ensureReadonlyRagAppUser();
      await assertReadonlyRagAppUserCannotWriteBusinessTables();
    }
    await this.startSidecar();
    console.log(`rag-heavy:${this.suiteName}:setup_ms=${nowMs() - startedAt}`);
  }

  async teardownSuite(): Promise<void> {
    await this.stopSidecar();
    if (this.releaseSuiteLock) {
      await this.releaseSuiteLock();
      this.releaseSuiteLock = null;
    }
  }

  async prepareCase(): Promise<void> {
    const startedAt = nowMs();
    await truncateBusinessTables();
    if (this.backend === 'haystack_pgvector') {
      await clearPgvectorTable(PGVECTOR_DATABASE_URL);
    }
    process.env.RAG_SERVICE_BASE_URL = this.baseUrl;
    process.env.RAG_SERVICE_TIMEOUT_MS = '30000';
    console.log(`rag-heavy:${this.suiteName}:prepare_case_ms=${nowMs() - startedAt}`);
  }

  async restartSidecar(input?: { appDatabaseUrl?: string }): Promise<void> {
    const startedAt = nowMs();
    await this.stopSidecar();
    if (input?.appDatabaseUrl) {
      this.appDatabaseUrl = input.appDatabaseUrl;
    }
    await this.startSidecar();
    console.log(`rag-heavy:${this.suiteName}:restart_sidecar_ms=${nowMs() - startedAt}`);
  }

  private async startSidecar(): Promise<void> {
    if (this.sidecar) {
      return;
    }

    const startedAt = nowMs();
    killPortListeners(this.port);
    if (this.backend === 'haystack_pgvector') {
      await ensurePgvectorContainer();
    }

    const stdoutPath = path.join(LOG_DIR, `${this.suiteName}.stdout.log`);
    const stderrPath = path.join(LOG_DIR, `${this.suiteName}.stderr.log`);
    await fs.promises.rm(stdoutPath, { force: true });
    await fs.promises.rm(stderrPath, { force: true });

    this.sidecar = spawn(
      SIDECAR_PYTHON,
      ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', String(this.port)],
      {
        cwd: SIDECAR_CWD,
        env: {
          ...process.env,
          APP_DATABASE_URL: this.appDatabaseUrl,
          RAG_BACKEND_MODE: this.backend,
          RAG_REQUIRE_PERSISTENT_BACKEND:
            this.backend === 'haystack_pgvector' ? 'true' : 'false',
          PG_CONN_STR: this.backend === 'haystack_pgvector' ? PGVECTOR_DATABASE_URL : '',
          HAYSTACK_EMBEDDING_MODEL: 'intfloat/multilingual-e5-small',
          HTTP_PROXY: process.env.HTTP_PROXY ?? 'http://127.0.0.1:7897',
          HTTPS_PROXY: process.env.HTTPS_PROXY ?? 'http://127.0.0.1:7897',
        },
        stdio: [
          'ignore',
          fs.openSync(stdoutPath, 'a'),
          fs.openSync(stderrPath, 'a'),
        ],
      },
    );

    if (this.backend === 'haystack_pgvector') {
      await waitForDatabaseReady(PGVECTOR_DATABASE_URL);
      await assertVectorExtension(PGVECTOR_DATABASE_URL);
    } else {
      await waitForDatabaseReady(this.appDatabaseUrl);
    }
    await waitForHttpReady(this.baseUrl, this.backend);
    if (getPortListeners(this.port).length === 0) {
      throw new Error(`sidecar port ${this.port} is not listening after startup`);
    }
    console.log(`rag-heavy:${this.suiteName}:sidecar_start_ms=${nowMs() - startedAt}`);
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
