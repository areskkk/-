import pg from 'pg';
import { loadEnv } from '../config/env.js';

const { Pool } = pg;

export function createPool(databaseUrl = loadEnv().databaseUrl): pg.Pool {
  return new Pool({
    connectionString: databaseUrl,
  });
}
