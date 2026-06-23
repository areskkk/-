import { query } from '../../db/query.js';
import { safeAuditDetail } from '../agents/runtime/agent-security.js';

export type AuditLogInput = {
  actor_id: string;
  action: string;
  target_type: string;
  target_id: string;
  trace_id?: string;
  detail?: Record<string, unknown>;
};

export type AuditRepository = {
  insert(input: Required<AuditLogInput>): Promise<void>;
};

export class NoopAuditRepository implements AuditRepository {
  logs: Required<AuditLogInput>[] = [];

  async insert(input: Required<AuditLogInput>): Promise<void> {
    this.logs.push(input);
  }
}

export class PostgresAuditRepository implements AuditRepository {
  async insert(input: Required<AuditLogInput>): Promise<void> {
    await query(
      `
        INSERT INTO audit_logs (actor_id, action, target_type, target_id, trace_id, detail)
        VALUES ($1, $2, $3, $4, $5, $6::jsonb)
      `,
      [
        input.actor_id,
        input.action,
        input.target_type,
        input.target_id,
        input.trace_id,
        JSON.stringify(input.detail),
      ],
    );
  }
}

export class AuditService {
  constructor(private readonly repository: AuditRepository) {}

  async write(input: AuditLogInput): Promise<void> {
    await this.repository.insert({
      actor_id: input.actor_id,
      action: input.action,
      target_type: input.target_type,
      target_id: input.target_id,
      trace_id: input.trace_id ?? '',
      detail: safeAuditDetail(input.detail ?? {}),
    });
  }
}

export const auditRepository = new PostgresAuditRepository();
export const auditService = new AuditService(auditRepository);
