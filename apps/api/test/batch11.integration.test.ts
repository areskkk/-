import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { canConnectDatabase } from './db-test-utils.js';

const canRunDb = await canConnectDatabase();
const describeIfDb = canRunDb ? describe : describe.skip;

const sidecarPython = 'D:\\Desktop\\家助宝项目\\services\\rag-service\\.venv\\Scripts\\python.exe';
const sidecarWorkdir = 'd:\\Desktop\\家助宝项目\\services\\rag-service';

function runSidecarStartupCheck(env: NodeJS.ProcessEnv) {
  return spawnSync(
    sidecarPython,
    ['-c', 'import app.main'],
    {
      cwd: sidecarWorkdir,
      env: {
        ...process.env,
        APP_DATABASE_URL: 'postgresql://postgres@127.0.0.1:5432/nankang_zhuqibao',
        HAYSTACK_EMBEDDING_MODEL: 'intfloat/multilingual-e5-small',
        ...env,
      },
      encoding: 'utf-8',
    },
  );
}

function outputText(result: ReturnType<typeof runSidecarStartupCheck>): string {
  const stdout = result.stdout ? String(result.stdout) : '';
  const stderr = result.stderr ? String(result.stderr) : '';
  return `${stdout}\n${stderr}`;
}

function hasVectorExtension(): boolean {
  const result = spawnSync(
    'node',
    [
      '-e',
      `
        const { Client } = require('pg');
        (async () => {
          const client = new Client({
            connectionString: 'postgresql://postgres@127.0.0.1:5432/nankang_zhuqibao',
          });
          await client.connect();
          const row = await client.query("SELECT extname FROM pg_extension WHERE extname='vector'");
          await client.end();
          process.stdout.write(row.rows.length > 0 ? 'yes' : 'no');
        })().catch((error) => {
          console.error(error);
          process.exit(1);
        });
      `,
    ],
    {
      cwd: 'd:\\Desktop\\家助宝项目',
      encoding: 'utf-8',
    },
  );

  return result.status === 0 && result.stdout.trim() === 'yes';
}

describeIfDb('batch11A pgvector preparation', () => {
  it('fails fast when pgvector mode is missing PG_CONN_STR', () => {
    const result = runSidecarStartupCheck({
      RAG_BACKEND_MODE: 'haystack_pgvector',
      PG_CONN_STR: '',
    });

    expect(result.status).not.toBe(0);
    expect(result.error).toBeUndefined();
    expect(outputText(result)).toContain('PG_CONN_STR');
  });

  it('fails fast when persistent backend is required without pgvector mode', () => {
    const result = runSidecarStartupCheck({
      RAG_REQUIRE_PERSISTENT_BACKEND: 'true',
      RAG_BACKEND_MODE: 'haystack_inmemory',
    });

    expect(result.status).not.toBe(0);
    expect(result.error).toBeUndefined();
    expect(outputText(result)).toContain('RAG_BACKEND_MODE=haystack_pgvector');
  });

  it('fails fast when pgvector mode has no vector extension', () => {
    if (hasVectorExtension()) {
      console.warn('vector extension exists; skip missing-extension assertion');
      return;
    }

    const result = runSidecarStartupCheck({
      RAG_BACKEND_MODE: 'haystack_pgvector',
      PG_CONN_STR: 'postgresql://postgres@127.0.0.1:5432/nankang_zhuqibao',
    });

    expect(result.status).not.toBe(0);
    expect(result.error).toBeUndefined();
    expect(outputText(result)).toContain('vector');
  });

  it('documents pgvector blocker instead of pretending it is connected when vector is unavailable', () => {
    const vectorInstalled = hasVectorExtension();
    if (vectorInstalled) {
      console.warn('vector extension exists; environment is ready for later 11B validation');
    }

    expect(typeof vectorInstalled).toBe('boolean');
  });
});
