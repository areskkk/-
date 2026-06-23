import pg, { type PoolClient, type QueryResultRow } from 'pg';
import { createPool } from './pool.js';

export const dbPool = createPool();

export async function query<T extends QueryResultRow>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const result = await dbPool.query<T>(sql, params);
  return result.rows;
}

export async function queryOne<T extends QueryResultRow>(
  sql: string,
  params: unknown[] = [],
): Promise<T | undefined> {
  const rows = await query<T>(sql, params);
  return rows[0];
}

export async function execute(
  sql: string,
  params: unknown[] = [],
): Promise<number> {
  const result = await dbPool.query(sql, params);
  return result.rowCount ?? 0;
}

export type DbTransaction = {
  query<T extends QueryResultRow>(sql: string, params?: unknown[]): Promise<T[]>;
  queryOne<T extends QueryResultRow>(sql: string, params?: unknown[]): Promise<T | undefined>;
  execute(sql: string, params?: unknown[]): Promise<number>;
};

function createTransaction(client: PoolClient): DbTransaction {
  return {
    async query<T extends QueryResultRow>(sql: string, params: unknown[] = []) {
      const result = await client.query<T>(sql, params);
      return result.rows;
    },
    async queryOne<T extends QueryResultRow>(sql: string, params: unknown[] = []) {
      const result = await client.query<T>(sql, params);
      return result.rows[0] as T | undefined;
    },
    async execute(sql: string, params: unknown[] = []) {
      const result = await client.query(sql, params);
      return result.rowCount ?? 0;
    },
  };
}

export async function withTransaction<T>(
  fn: (tx: DbTransaction) => Promise<T>,
): Promise<T> {
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    const tx = createTransaction(client);
    const result = await fn(tx);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
