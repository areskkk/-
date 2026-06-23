import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { loadEnv } from '../config/env.js';

const { Client } = pg;

export type Migration = {
  id: string;
  filePath: string;
  sql: string;
};

const currentFile = fileURLToPath(import.meta.url);
const currentDir = path.dirname(currentFile);
const migrationsDir = path.join(currentDir, 'migrations');

export function isDirectExecution(metaUrl: string, argvEntry?: string): boolean {
  if (!argvEntry) {
    return false;
  }

  const modulePath = path.resolve(fileURLToPath(metaUrl));
  const entryPath = path.resolve(argvEntry);
  return modulePath === entryPath;
}

export function loadMigrations(directory = migrationsDir): Migration[] {
  return fs
    .readdirSync(directory)
    .filter((fileName) => fileName.endsWith('.sql'))
    .sort()
    .map((fileName) => {
      const filePath = path.join(directory, fileName);
      return {
        id: fileName,
        filePath,
        sql: fs.readFileSync(filePath, 'utf8'),
      };
    });
}

export async function runMigrations(databaseUrl = loadEnv().databaseUrl): Promise<void> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    for (const migration of loadMigrations()) {
      const applied = await client.query(
        'SELECT id FROM schema_migrations WHERE id = $1',
        [migration.id],
      );

      if (applied.rowCount && applied.rowCount > 0) {
        continue;
      }

      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [
          migration.id,
        ]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    await client.end();
  }
}

if (isDirectExecution(import.meta.url, process.argv[1])) {
  runMigrations()
    .then(() => {
      console.log('Migrations completed');
    })
    .catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
}
