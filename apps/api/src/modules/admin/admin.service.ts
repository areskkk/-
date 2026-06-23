import { query, queryOne } from '../../db/query.js';
import { normalizePageQuery, pageResult, type PageQuery } from '../../common/pagination/pagination.js';
import { ApiError } from '../../common/errors/http-error.js';
import { auditService } from '../audit/audit.service.js';
import { listStepsByRunId, listToolCallsByRunId, updateRunState } from '../agents/agents.repository.js';
import { type AgentRunRow } from '../agents/agents.types.js';
import { buildTenantPolicy, discoverCapabilities, listPluginRegistry } from '../agents/runtime/platform-ecosystem.js';
import { buildActionReplayTrace, evaluateSlaGate, type SlaGateInput } from '../agents/runtime/platform-observability.js';
import { scanAndEscalateExpiredWorkflowWaits } from '../agents/runtime/workflow-waits.repository.js';
import {
  decideApprovalRequest,
  getAgentCostDashboard,
  getAgentKillSwitch,
  listApprovalRequests,
  setAgentKillSwitch,
  type AgentOpsControlInput,
} from '../agents/runtime/agent-ops-control.js';
import { resetToolCircuit } from '../agents/tools/tool-health.js';
import { type AgentToolName } from '../agents/tools/tool.types.js';
import {
  importEnterpriseProfilesInTransaction,
  type EnterpriseProfileImportRow,
} from '../enterprise-profile/enterprise-profile.repository.js';

export type AuditLogRow = {
  log_id: string;
  actor_id: string;
  action: string;
  target_type: string;
  target_id: string;
  trace_id: string | null;
  detail: Record<string, unknown>;
  created_at: string;
};

export type EnterpriseProfileImportRequest = {
  idempotency_key?: string;
  mode?: 'upsert';
  source?: string;
  rows: Array<Omit<EnterpriseProfileImportRow, 'source'> & {
    source?: string;
  }>;
};

function isValidCreditCode(value: string): boolean {
  return /^[0-9A-Z]{18}$/.test(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isValidOptionalNumber(value: unknown): boolean {
  return value === undefined ||
    value === null ||
    (typeof value === 'number' && Number.isFinite(value));
}

function isValidOptionalInteger(value: unknown): boolean {
  return value === undefined ||
    value === null ||
    (typeof value === 'number' && Number.isInteger(value));
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export class AdminService {
  async importEnterpriseProfiles(
    actorId: string,
    traceId: string,
    input: EnterpriseProfileImportRequest,
  ) {
    if (!input || typeof input !== 'object') {
      throw new ApiError('VALIDATION_ERROR', 'request body is required');
    }
    if (input.mode && input.mode !== 'upsert') {
      throw new ApiError('VALIDATION_ERROR', 'mode must be upsert');
    }
    if (!Array.isArray(input.rows) || input.rows.length === 0) {
      throw new ApiError('VALIDATION_ERROR', 'rows are required');
    }
    if (input.rows.length > 1000) {
      throw new ApiError('VALIDATION_ERROR', 'rows must not exceed 1000');
    }

    const validRows: EnterpriseProfileImportRow[] = [];
    const errors: Array<{ index: number; code: string; message: string }> = [];

    input.rows.forEach((row, index) => {
      if (!isPlainObject(row)) {
        errors.push({
          index,
          code: 'VALIDATION_ERROR',
          message: 'row must be an object',
        });
        return;
      }
      const enterpriseName = optionalString(row.enterprise_name)?.trim();
      const creditCode = optionalString(row.credit_code)?.trim().toUpperCase();
      if (!enterpriseName || !creditCode) {
        errors.push({
          index,
          code: 'VALIDATION_ERROR',
          message: 'enterprise_name and credit_code are required',
        });
        return;
      }
      if (!isValidCreditCode(creditCode)) {
        errors.push({
          index,
          code: 'VALIDATION_ERROR',
          message: 'credit_code must be 18 uppercase letters or digits',
        });
        return;
      }
      const numericFields = [
        'revenue_amount',
        'employee_count',
        'tax_amount',
        'export_amount',
      ] as const;
      const invalidNumericField = numericFields.find((field) =>
        !isValidOptionalNumber(row[field]),
      );
      if (invalidNumericField) {
        errors.push({
          index,
          code: 'VALIDATION_ERROR',
          message: `${invalidNumericField} must be a finite number`,
        });
        return;
      }
      if (!isValidOptionalInteger(row.employee_count)) {
        errors.push({
          index,
          code: 'VALIDATION_ERROR',
          message: 'employee_count must be an integer',
        });
        return;
      }
      validRows.push({
        enterprise_name: enterpriseName,
        credit_code: creditCode,
        industry: optionalString(row.industry) ?? null,
        scale: optionalString(row.scale) ?? null,
        revenue_amount: row.revenue_amount as number | null | undefined ?? null,
        employee_count: row.employee_count as number | null | undefined ?? null,
        tax_amount: row.tax_amount as number | null | undefined ?? null,
        export_amount: row.export_amount as number | null | undefined ?? null,
        tech_upgrade_status: optionalString(row.tech_upgrade_status) ?? null,
        source: optionalString(row.source) ?? input.source ?? 'government_import',
        profile_json: isPlainObject(row.profile_json) ? row.profile_json : {},
      });
    });

    const imported = validRows.length > 0
      ? await importEnterpriseProfilesInTransaction(validRows)
      : [];
    const inserted = imported.filter((row) => !row.profile_existed).length;
    const updated = imported.filter((row) => row.profile_existed).length;

    await auditService.write({
      actor_id: actorId,
      action: 'enterprise_profile.import',
      target_type: 'enterprise_profile_import',
      target_id: input.idempotency_key ?? traceId,
      trace_id: traceId,
      detail: {
        idempotency_key: input.idempotency_key ?? null,
        source: input.source ?? 'government_import',
        total: input.rows.length,
        inserted,
        updated,
        failed: errors.length,
      },
    });

    return {
      import_id: input.idempotency_key ?? traceId,
      total: input.rows.length,
      inserted,
      updated,
      failed: errors.length,
      errors,
    };
  }

  async listAuditLogs(queryInput: PageQuery) {
    const normalized = normalizePageQuery(queryInput);
    const offset = (normalized.page - 1) * normalized.page_size;

    const items = await query<AuditLogRow>(
      `
        SELECT
          log_id,
          actor_id,
          action,
          target_type,
          target_id,
          trace_id,
          detail,
          created_at::text
        FROM audit_logs
        ORDER BY created_at DESC
        LIMIT $1 OFFSET $2
      `,
      [normalized.page_size, offset],
    );

    const totalRow = await queryOne<{ total: string }>(
      'SELECT COUNT(*)::text AS total FROM audit_logs',
    );

    return pageResult(items, Number(totalRow?.total ?? '0'), normalized);
  }

  async listAgentRuns(queryInput: PageQuery & {
    status?: string;
    trace_id?: string;
  }) {
    const normalized = normalizePageQuery(queryInput);
    const offset = (normalized.page - 1) * normalized.page_size;
    const status = typeof queryInput.status === 'string' && queryInput.status.trim() !== ''
      ? queryInput.status.trim()
      : null;
    const traceId = typeof queryInput.trace_id === 'string' && queryInput.trace_id.trim() !== ''
      ? queryInput.trace_id.trim()
      : null;

    const items = await query(
      `
        SELECT *
        FROM agent_run_observability
        WHERE ($1::text IS NULL OR status = $1)
          AND ($2::text IS NULL OR trace_id = $2)
        ORDER BY started_at DESC
        LIMIT $3 OFFSET $4
      `,
      [status, traceId, normalized.page_size, offset],
    );
    const totalRow = await queryOne<{ total: string }>(
      `
        SELECT count(*)::text AS total
        FROM agent_run_observability
        WHERE ($1::text IS NULL OR status = $1)
          AND ($2::text IS NULL OR trace_id = $2)
      `,
      [status, traceId],
    );
    return pageResult(items, Number(totalRow?.total ?? '0'), normalized);
  }

  async getAgentRunDetail(runId: string) {
    const run = await queryOne(
      `
        SELECT *
        FROM agent_run_observability
        WHERE run_id = $1
      `,
      [runId],
    );
    const [steps, toolCalls, llmCalls, resumeRequests] = await Promise.all([
      query(
        `
          SELECT *
          FROM agent_run_steps
          WHERE run_id = $1
          ORDER BY started_at ASC
        `,
        [runId],
      ),
      query(
        `
          SELECT *
          FROM agent_tool_calls
          WHERE run_id = $1
          ORDER BY started_at ASC
        `,
        [runId],
      ),
      query(
        `
          SELECT
            llm_call_id::text,
            run_id::text,
            trace_id,
            agent_type,
            model_name,
            prompt_version,
            status,
            token_usage,
            estimated_cost_cents::text,
            latency_ms,
            error_type,
            created_at::text
          FROM agent_llm_calls
          WHERE run_id = $1
          ORDER BY created_at ASC
        `,
        [runId],
      ),
      query(
        `
          SELECT
            resume_request_id::text,
            task_id::text,
            idempotency_key,
            status,
            error_message,
            created_at::text,
            completed_at::text
          FROM agent_resume_requests
          WHERE run_id = $1
          ORDER BY created_at ASC
        `,
        [runId],
      ),
    ]);
    return {
      run,
      steps,
      tool_calls: toolCalls,
      llm_calls: llmCalls,
      resume_requests: resumeRequests,
    };
  }

  async getAgentMetrics(input: { fallback_sla_minutes: number }) {
    const [
      jobs,
      staleJobs,
      runs,
      llm,
      modelHealth,
      toolHealth,
      fallback,
      fallbackReasonRows,
      dailyBudgetOverrun,
    ] = await Promise.all([
      query(
        `
          SELECT status, count(*)::int AS count
          FROM agent_run_jobs
          GROUP BY status
        `,
      ),
      queryOne<{ stale_count: string }>(
        `
          SELECT count(*)::text AS stale_count
          FROM agent_run_jobs
          WHERE status = 'running'
            AND COALESCE(heartbeat_at, locked_at) < now() - interval '15 minutes'
        `,
      ),
      query(
        `
          SELECT status, count(*)::int AS count
          FROM agent_runs
          GROUP BY status
        `,
      ),
      queryOne<{
        llm_call_count: string;
        total_tokens: string;
        estimated_cost_cents: string;
        failed_calls: string;
      }>(
        `
          SELECT
            count(*)::text AS llm_call_count,
            COALESCE(sum((token_usage->>'total_tokens')::int), 0)::text AS total_tokens,
            COALESCE(sum(estimated_cost_cents), 0)::text AS estimated_cost_cents,
            count(*) FILTER (WHERE status = 'failed')::text AS failed_calls
          FROM agent_llm_calls
        `,
      ),
      query(
        `
          SELECT
            model_name,
            request_count,
            error_count,
            rate_limit_count,
            CASE
              WHEN request_count = 0 THEN 0
              ELSE round(error_count::numeric / request_count, 4)
            END AS error_rate,
            circuit_open_until::text,
            last_error
          FROM agent_model_health
          ORDER BY updated_at DESC
        `,
      ),
      query(
        `
          SELECT
            tool_name,
            request_count,
            error_count,
            CASE
              WHEN request_count = 0 THEN 0
              ELSE round(error_count::numeric / request_count, 4)
            END AS error_rate,
            circuit_open_until::text,
            last_error
          FROM agent_tool_health
          ORDER BY updated_at DESC
        `,
      ),
      queryOne<{
        pending_count: string;
        overdue_count: string;
        avg_minutes: string | null;
      }>(
        `
          SELECT
            count(*) FILTER (WHERE status = 'pending')::text AS pending_count,
            count(*) FILTER (
              WHERE status = 'pending'
                AND created_at < now() - ($1::int * interval '1 minute')
            )::text AS overdue_count,
            avg(EXTRACT(EPOCH FROM (resolved_at - created_at)) / 60)::text AS avg_minutes
          FROM fallback_tasks
          WHERE source_type = 'agent_run'
        `,
        [input.fallback_sla_minutes],
      ),
      query(
        `
          SELECT reason, count(*)::int AS count
          FROM fallback_tasks
          WHERE source_type = 'agent_run'
          GROUP BY reason
          ORDER BY count DESC, reason ASC
        `,
      ),
      queryOne<{
        count: string;
        latest_at: string | null;
        latest_detail: Record<string, unknown> | null;
      }>(
        `
          SELECT
            count(*)::text AS count,
            max(created_at)::text AS latest_at,
            (
              SELECT detail
              FROM audit_logs latest
              WHERE latest.action = 'llm.daily_budget.overrun'
              ORDER BY latest.created_at DESC
              LIMIT 1
            ) AS latest_detail
          FROM audit_logs
          WHERE action = 'llm.daily_budget.overrun'
            AND created_at >= now() - interval '24 hours'
        `,
      ),
    ]);
    const runCounts = Object.fromEntries(
      (runs as Array<{ status: string; count: number }>).map((row) => [row.status, row.count]),
    );
    const completedRuns = Number(runCounts.completed ?? 0);
    const failedRuns = Number(runCounts.failed ?? 0);
    const interruptedRuns = Number(runCounts.interrupted ?? 0);
    const totalTerminalRuns = completedRuns + failedRuns + interruptedRuns;
    return {
      jobs,
      queue_depth: {
        queued: countByStatus(jobs, 'queued'),
        running: countByStatus(jobs, 'running'),
        failed: countByStatus(jobs, 'failed'),
        stale: Number(staleJobs?.stale_count ?? 0),
      },
      runs,
      run_rates: {
        success_rate: totalTerminalRuns === 0 ? 0 : completedRuns / totalTerminalRuns,
        failed_rate: totalTerminalRuns === 0 ? 0 : failedRuns / totalTerminalRuns,
        interrupted_rate: totalTerminalRuns === 0 ? 0 : interruptedRuns / totalTerminalRuns,
        resume_failed_count: Number(runCounts.resume_failed ?? 0),
      },
      llm: {
        call_count: Number(llm?.llm_call_count ?? 0),
        total_tokens: Number(llm?.total_tokens ?? 0),
        estimated_cost_cents: Number(llm?.estimated_cost_cents ?? 0),
        failed_calls: Number(llm?.failed_calls ?? 0),
      },
      model_health: modelHealth,
      tool_health: toolHealth,
      fallback_sla: {
        pending_count: Number(fallback?.pending_count ?? 0),
        overdue_count: Number(fallback?.overdue_count ?? 0),
        avg_minutes: fallback?.avg_minutes === null ? null : Number(fallback?.avg_minutes ?? 0),
        sla_minutes: input.fallback_sla_minutes,
        by_reason: fallbackReasonRows,
      },
      alerts: {
        daily_budget_overrun: {
          status: Number(dailyBudgetOverrun?.count ?? 0) > 0 ? 'firing' : 'ok',
          count_24h: Number(dailyBudgetOverrun?.count ?? 0),
          latest_at: dailyBudgetOverrun?.latest_at ?? null,
          latest_detail: dailyBudgetOverrun?.latest_detail ?? null,
          operator_action:
            Number(dailyBudgetOverrun?.count ?? 0) > 0
              ? 'pause_non_critical_agent_runs_and_follow_budget_sla_runbook'
              : null,
        },
      },
    };
  }

  async getAgentRunActionReplay(runId: string) {
    const detail = await this.getAgentRunDetail(runId);
    if (!detail.run) {
      throw new ApiError('NOT_FOUND', 'agent run not found');
    }
    return buildActionReplayTrace({
      run: detail.run as AgentRunRow,
      steps: await listStepsByRunId(runId),
      tool_calls: await listToolCallsByRunId(runId),
    });
  }

  async getAgentSlaGate(policy: SlaGateInput = {}) {
    const metrics = await this.getAgentMetrics({
      fallback_sla_minutes: Number(policy.max_fallback_overdue_count ?? 15),
    });
    return evaluateSlaGate({
      metrics,
      policy,
    });
  }

  async discoverAgentCapabilities(input?: {
    tenant_id?: string;
    allowed_agents?: string[];
    allowed_tools?: string[];
    plugin_allowlist?: string[];
  }) {
    const tenant = buildTenantPolicy({
      tenant_id: input?.tenant_id,
      allowed_agents: input?.allowed_agents as never,
      allowed_tools: input?.allowed_tools as never,
      plugin_allowlist: input?.plugin_allowlist,
    });
    return {
      tenant,
      capabilities: discoverCapabilities({ tenant }),
    };
  }

  async listAgentPlugins(input?: {
    tenant_id?: string;
    plugin_allowlist?: string[];
  }) {
    const tenant = buildTenantPolicy({
      tenant_id: input?.tenant_id,
      plugin_allowlist: input?.plugin_allowlist,
    });
    return {
      tenant_id: tenant.tenant_id,
      plugins: listPluginRegistry({ tenant }),
    };
  }

  async scanWorkflowSla(input: {
    actor_id: string;
    trace_id?: string;
    now?: string;
    limit?: number;
  }) {
    return scanAndEscalateExpiredWorkflowWaits({
      actor_id: input.actor_id,
      trace_id: input.trace_id,
      now: input.now ? new Date(input.now) : undefined,
      limit: input.limit,
    });
  }

  async getAgentCostDashboard() {
    return getAgentCostDashboard();
  }

  async getAgentOpsControls() {
    return {
      kill_switch: await getAgentKillSwitch(),
    };
  }

  async setAgentKillSwitch(input: {
    actor_id: string;
    trace_id?: string;
    body: AgentOpsControlInput;
  }) {
    return setAgentKillSwitch({
      actor_id: input.actor_id,
      trace_id: input.trace_id,
      control: input.body,
    });
  }

  async listAgentApprovalRequests(queryInput: { status?: string }) {
    const status = typeof queryInput.status === 'string' && queryInput.status.trim() !== ''
      ? queryInput.status.trim()
      : undefined;
    return {
      items: await listApprovalRequests({ status }),
    };
  }

  async decideAgentApproval(input: {
    actor_id: string;
    trace_id?: string;
    run_id: string;
    approval_id: string;
    body: {
      status: 'approved' | 'rejected';
      comment?: string;
    };
  }) {
    if (!['approved', 'rejected'].includes(input.body.status)) {
      throw new ApiError('VALIDATION_ERROR', 'status must be approved or rejected');
    }
    const run = await queryOne<AgentRunRow>(
      `
        SELECT
          run_id::text,
          actor_id,
          entrypoint,
          status,
          current_node,
          state,
          idempotency_key,
          trace_id,
          error_message,
          started_at::text,
          interrupted_at::text,
          completed_at::text,
          updated_at::text,
          version
        FROM agent_runs
        WHERE run_id = $1
      `,
      [input.run_id],
    );
    if (!run) {
      throw new ApiError('NOT_FOUND', 'agent run not found');
    }
    const state = await decideApprovalRequest({
      actor_id: input.actor_id,
      trace_id: input.trace_id,
      run,
      approval_id: input.approval_id,
      status: input.body.status,
      comment: input.body.comment,
    });
    const updated = await updateRunState({
      run_id: run.run_id,
      status: run.status,
      current_node: run.current_node,
      state,
      expected_version: run.version,
      allow_terminal_override: true,
    });
    if (!updated) {
      throw new ApiError('CONFLICT', 'agent run state changed before approval decision');
    }
    return {
      run_id: updated.run_id,
      approval_id: input.approval_id,
      status: input.body.status,
    };
  }

  async resetAgentToolCircuit(input: {
    actor_id: string;
    trace_id?: string;
    tool_name: AgentToolName;
  }) {
    return resetToolCircuit(input);
  }
}

export const adminService = new AdminService();

function countByStatus(rows: unknown[], status: string): number {
  const row = (rows as Array<{ status: string; count: number }>)
    .find((item) => item.status === status);
  return Number(row?.count ?? 0);
}
