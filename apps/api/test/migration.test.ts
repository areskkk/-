import { describe, expect, it } from 'vitest';
import { pathToFileURL } from 'node:url';
import { isDirectExecution, loadMigrations } from '../src/db/migrate.js';

describe('database migrations', () => {
  it('loads the init migration with core tables and enums', () => {
    const migrations = loadMigrations();
    const init = migrations.find((migration) => migration.id === '001_init.sql');

    expect(init).toBeDefined();
    expect(init?.sql).toContain('CREATE TYPE application_status AS ENUM');
    expect(init?.sql).toContain('CREATE TABLE applications');
    expect(init?.sql).toContain('CREATE TABLE audit_logs');
    expect(init?.sql).toContain('CREATE TABLE langgraph_checkpoints');
  });

  it('detects direct execution after path normalization', () => {
    const filePath = 'D:\\workspace\\src\\db\\migrate.ts';
    const metaUrl = pathToFileURL(filePath).href;

    expect(isDirectExecution(metaUrl, filePath)).toBe(true);
    expect(isDirectExecution(metaUrl, 'D:\\workspace\\src\\main.ts')).toBe(false);
    expect(isDirectExecution(metaUrl, undefined)).toBe(false);
  });
});
