import pg, { type QueryResultRow } from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadEnv } from '../src/config/env.js';
import { runMigrations } from '../src/db/migrate.js';

const { Client } = pg;
const TEST_LOCK_DIR = path.resolve('.tmp/test-locks');

export async function acquireTestLock(
  name: string,
  timeoutMs = 300000,
): Promise<() => Promise<void>> {
  await fs.promises.mkdir(TEST_LOCK_DIR, { recursive: true });
  const lockPath = path.join(TEST_LOCK_DIR, name);
  const ownerPath = path.join(lockPath, 'owner.json');
  const startedAt = Date.now();

  while (true) {
    try {
      await fs.promises.mkdir(lockPath);
      await fs.promises.writeFile(
        ownerPath,
        JSON.stringify({
          pid: process.pid,
          started_at: new Date().toISOString(),
        }),
      );
      return async () => {
        await fs.promises.rm(lockPath, { recursive: true, force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
      if (await isStaleTestLock(lockPath, ownerPath)) {
        await fs.promises.rm(lockPath, { recursive: true, force: true });
        continue;
      }
      if (Date.now() - startedAt > timeoutMs) {
        throw new Error(`Timed out waiting for test lock: ${name}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

async function isStaleTestLock(lockPath: string, ownerPath: string): Promise<boolean> {
  try {
    const raw = await fs.promises.readFile(ownerPath, 'utf-8');
    const owner = JSON.parse(raw) as { pid?: unknown };
    if (typeof owner.pid !== 'number' || !Number.isInteger(owner.pid)) {
      return true;
    }
    try {
      process.kill(owner.pid, 0);
      return false;
    } catch {
      return true;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      return true;
    }
    const stat = await fs.promises.stat(lockPath);
    return Date.now() - stat.mtimeMs > 30_000;
  }
}

export async function canConnectDatabase(): Promise<boolean> {
  const client = new Client({ connectionString: loadEnv().databaseUrl });
  try {
    await client.connect();
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}

export async function prepareDatabase(): Promise<void> {
  await runMigrations(loadEnv().databaseUrl);
}

export async function truncateBusinessTables(): Promise<void> {
  const client = new Client({ connectionString: loadEnv().databaseUrl });
  await client.connect();
  try {
    await client.query(`
      TRUNCATE TABLE
        review_agent_drafts,
        agent_run_replays,
        agent_ops_controls,
        agent_tool_health,
        agent_quota_reservations,
        agent_llm_calls,
        agent_resume_requests,
        agent_run_jobs,
        agent_tool_calls,
        agent_run_steps,
        agent_runs,
        agent_model_health,
        langgraph_checkpoints,
        audit_logs,
        review_records,
        ocr_jobs,
        ocr_results,
        policy_chunks,
        materials,
        files,
        application_policy_items,
        applications,
        enterprise_profile_snapshots,
        policy_material_requirements,
        policy_conditions,
        fallback_tasks,
        enterprise_profiles,
        enterprise_accounts,
        enterprises,
        policy_ai_whitelist,
        user_roles,
        users,
        policies
      RESTART IDENTITY CASCADE
    `);
    await client.query(`
      INSERT INTO roles (code, name, scope) VALUES
        ('owner', 'Enterprise Owner', 'enterprise'),
        ('manager', 'Enterprise Manager', 'enterprise'),
        ('operator', 'Enterprise Operator', 'enterprise'),
        ('viewer', 'Enterprise Viewer', 'enterprise'),
        ('system_admin', 'System Admin', 'admin'),
        ('policy_admin', 'Policy Admin', 'admin'),
        ('kb_operator', 'Knowledge Base Operator', 'admin'),
        ('qa_reviewer', 'QA Reviewer', 'admin'),
        ('window_staff', 'Window Staff', 'government'),
        ('reviewer', 'Reviewer', 'government'),
        ('department_lead', 'Department Lead', 'government')
      ON CONFLICT (code) DO NOTHING
    `);
  } finally {
    await client.end();
  }
}

export async function clearConfiguredTestUploadDir(): Promise<void> {
  const configuredRoot = loadEnv().fileStorageRoot;
  const resolvedRoot = path.resolve(configuredRoot);
  const workspaceRoot = path.resolve('.');
  const allowedTmpRoot = path.resolve('.tmp');

  if (
    !resolvedRoot.startsWith(allowedTmpRoot + path.sep) ||
    !resolvedRoot.startsWith(workspaceRoot + path.sep)
  ) {
    throw new Error(
      `Refusing to clear non-test upload directory: ${resolvedRoot}`,
    );
  }

  await fs.promises.rm(resolvedRoot, { recursive: true, force: true });
  await fs.promises.mkdir(resolvedRoot, { recursive: true });
}

export async function getRows<T extends QueryResultRow>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const client = new Client({ connectionString: loadEnv().databaseUrl });
  await client.connect();
  try {
    const result = await client.query<T>(sql, params);
    return result.rows;
  } finally {
    await client.end();
  }
}

export async function createApprovedEnterpriseForUser(input: {
  userId: string;
  enterpriseName: string;
  creditCode: string;
  role?: string;
  authStatus?: 'agent_approved' | 'manual_approved';
}): Promise<string> {
  const rows = await getRows<{ enterprise_id: string }>(
    `
      INSERT INTO enterprises (name, credit_code, status)
      VALUES ($1, $2, 'active')
      RETURNING enterprise_id::text
    `,
    [input.enterpriseName, input.creditCode],
  );
  const enterpriseId = rows[0].enterprise_id;

  await getRows(
    `
      INSERT INTO enterprise_accounts (enterprise_id, user_id, role, auth_status)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (enterprise_id, user_id)
      DO UPDATE SET role = EXCLUDED.role, auth_status = EXCLUDED.auth_status
    `,
    [
      enterpriseId,
      input.userId,
      input.role ?? 'owner',
      input.authStatus ?? 'manual_approved',
    ],
  );

  await getRows(
    `
      INSERT INTO user_roles (user_id, role_id)
      SELECT $1, role_id
      FROM roles
      WHERE code = $2
      ON CONFLICT (user_id, role_id) DO NOTHING
    `,
    [input.userId, input.role ?? 'owner'],
  );

  return enterpriseId;
}

export async function withDbClient<T>(
  fn: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new Client({ connectionString: loadEnv().databaseUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

export function getPortListeners(port: number): number[] {
  try {
    const output = execFileSync(
      'netstat',
      ['-ano', '-p', 'tcp'],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const listeners = new Set<number>();
    for (const line of output.split(/\r?\n/)) {
      if (!line.includes(`:${port}`)) {
        continue;
      }
      const parts = line.trim().split(/\s+/);
      const pid = Number(parts[parts.length - 1]);
      if (Number.isInteger(pid) && pid > 0) {
        listeners.add(pid);
      }
    }
    return [...listeners];
  } catch {
    return [];
  }
}

export async function waitForPortToBeFree(
  port: number,
  timeoutMs = 30000,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (getPortListeners(port).length === 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for port ${port} to become free`);
}

export function killPortListeners(port: number): void {
  const listeners = getPortListeners(port);
  for (const pid of listeners) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Best-effort cleanup for test stability.
    }
  }
}
