import { ApiError } from '../../../common/errors/http-error.js';
import { query, queryOne } from '../../../db/query.js';
import { auditService } from '../../audit/audit.service.js';
import { type AgentGraphState, type AgentRunRow } from '../agents.types.js';

export type AgentOpsControlInput = {
  enabled: boolean;
  scope?: 'all' | 'run_creation' | 'llm' | 'tool' | 'resume';
  reason?: string;
};

export async function assertAgentKillSwitchOpen(input: {
  scope: 'run_creation' | 'llm' | 'tool' | 'resume';
  run_id?: string;
  tool_name?: string;
  model_name?: string;
}): Promise<void> {
  const control = await getAgentKillSwitch();
  if (!control.enabled) {
    return;
  }
  if (control.scope && control.scope !== 'all' && control.scope !== input.scope) {
    return;
  }
  throw new ApiError('FORBIDDEN', 'agent kill switch is enabled', {
    scope: input.scope,
    run_id: input.run_id ?? null,
    tool_name: input.tool_name ?? null,
    model_name: input.model_name ?? null,
    reason: control.reason ?? null,
  });
}

export async function setAgentKillSwitch(input: {
  actor_id: string;
  trace_id?: string;
  control: AgentOpsControlInput;
}) {
  const value = {
    enabled: input.control.enabled,
    scope: input.control.scope ?? 'all',
  };
  const row = await queryOne<{
    control_key: string;
    control_value: Record<string, unknown>;
    updated_by: string;
    reason: string | null;
    updated_at: string;
  }>(
    `
      INSERT INTO agent_ops_controls (
        control_key,
        control_value,
        updated_by,
        reason
      )
      VALUES ('kill_switch', $1::jsonb, $2, $3)
      ON CONFLICT (control_key) DO UPDATE
      SET
        control_value = EXCLUDED.control_value,
        updated_by = EXCLUDED.updated_by,
        reason = EXCLUDED.reason
      RETURNING
        control_key,
        control_value,
        updated_by,
        reason,
        updated_at::text
    `,
    [
      JSON.stringify(value),
      input.actor_id,
      input.control.reason ?? null,
    ],
  );
  await auditService.write({
    actor_id: input.actor_id,
    action: input.control.enabled
      ? 'agent_ops.kill_switch.enabled'
      : 'agent_ops.kill_switch.disabled',
    target_type: 'agent_ops_control',
    target_id: 'kill_switch',
    trace_id: input.trace_id,
    detail: {
      ...value,
      reason: input.control.reason ?? null,
    },
  });
  return normalizeKillSwitchRow(row);
}

export async function getAgentKillSwitch() {
  const row = await queryOne<{
    control_value: Record<string, unknown>;
    updated_by: string;
    reason: string | null;
    updated_at: string;
  }>(
    `
      SELECT control_value, updated_by, reason, updated_at::text
      FROM agent_ops_controls
      WHERE control_key = 'kill_switch'
    `,
  );
  return normalizeKillSwitchRow(row);
}

export async function createReplayRecord(input: {
  source_run_id: string;
  replay_run_id?: string;
  actor_id: string;
  reason?: string;
  trace_id?: string;
}) {
  const row = await queryOne(
    `
      INSERT INTO agent_run_replays (
        source_run_id,
        replay_run_id,
        actor_id,
        reason
      )
      VALUES ($1, $2, $3, $4)
      RETURNING
        replay_id::text,
        source_run_id::text,
        replay_run_id::text,
        actor_id,
        reason,
        status,
        created_at::text
    `,
    [
      input.source_run_id,
      input.replay_run_id ?? null,
      input.actor_id,
      input.reason ?? null,
    ],
  );
  await auditService.write({
    actor_id: input.actor_id,
    action: 'agent_run.replay.created',
    target_type: 'agent_run',
    target_id: input.source_run_id,
    trace_id: input.trace_id,
    detail: {
      source_run_id: input.source_run_id,
      replay_run_id: input.replay_run_id ?? null,
      replay_created: Boolean(input.replay_run_id),
      reason: input.reason ?? null,
    },
  });
  return row;
}

export async function attachReplayRun(input: {
  replay_id: string;
  replay_run_id: string;
}) {
  return queryOne(
    `
      UPDATE agent_run_replays
      SET replay_run_id = $2
      WHERE replay_id = $1
      RETURNING
        replay_id::text,
        source_run_id::text,
        replay_run_id::text,
        actor_id,
        reason,
        status,
        created_at::text
    `,
    [input.replay_id, input.replay_run_id],
  );
}

export async function markReplayFailed(input: {
  replay_id: string;
  source_run_id: string;
  replay_run_id?: string;
  actor_id: string;
  trace_id?: string;
  error_message?: string;
}) {
  const row = await queryOne(
    `
      UPDATE agent_run_replays
      SET
        status = 'failed',
        replay_run_id = COALESCE($2::uuid, replay_run_id)
      WHERE replay_id = $1
      RETURNING
        replay_id::text,
        source_run_id::text,
        replay_run_id::text,
        actor_id,
        reason,
        status,
        created_at::text
    `,
    [
      input.replay_id,
      input.replay_run_id ?? null,
    ],
  );
  await auditService.write({
    actor_id: input.actor_id,
    action: 'agent_run.replay.failed',
    target_type: 'agent_run',
    target_id: input.source_run_id,
    trace_id: input.trace_id,
    detail: {
      source_run_id: input.source_run_id,
      replay_run_id: input.replay_run_id ?? null,
      replay_created: Boolean(input.replay_run_id),
      error_message: input.error_message ?? null,
    },
  });
  return row;
}

export async function listApprovalRequests(input: {
  status?: string;
}) {
  return query(
    `
      SELECT
        run_id::text,
        actor_id,
        entrypoint,
        status AS run_status,
        trace_id,
        approval.value AS approval_request,
        updated_at::text
      FROM agent_runs
      CROSS JOIN LATERAL jsonb_array_elements(
        COALESCE(state->'control'->'approval_requests', '[]'::jsonb)
      ) approval(value)
      WHERE ($1::text IS NULL OR approval.value->>'status' = $1)
      ORDER BY updated_at DESC
    `,
    [input.status ?? null],
  );
}

export async function decideApprovalRequest(input: {
  actor_id: string;
  trace_id?: string;
  run: AgentRunRow;
  approval_id: string;
  status: 'approved' | 'rejected';
  comment?: string;
}): Promise<AgentGraphState> {
  const approvals = readApprovalRequests(input.run.state);
  const found = approvals.find((approval) => approval.approval_id === input.approval_id);
  if (!found) {
    throw new ApiError('NOT_FOUND', 'approval request not found');
  }
  if (found.status !== 'pending') {
    throw new ApiError('CONFLICT', 'approval request already decided');
  }
  const decidedAt = new Date().toISOString();
  const state = {
    ...input.run.state,
    runtime: {
      ...(input.run.state.runtime ?? {}),
      pending_tool_approval: updatePendingToolApprovalAfterDecision({
        pending: input.run.state.runtime?.pending_tool_approval,
        approval_id: input.approval_id,
        status: input.status,
        decided_at: decidedAt,
        comment: input.comment,
      }),
    },
    control: {
      ...readControl(input.run.state),
      approval_requests: approvals.map((approval) => (
        approval.approval_id === input.approval_id
          ? {
              ...approval,
              status: input.status,
              decided_by: input.actor_id,
              decided_at: decidedAt,
              comment: input.comment,
            }
          : approval
      )),
      manual_resume: input.status === 'approved',
      approval_resume_status: input.status === 'approved'
        ? 'awaiting_resume'
        : 'rejected',
      approval_resume_required: input.status === 'approved',
    },
  };
  await auditService.write({
    actor_id: input.actor_id,
    action: input.status === 'approved'
      ? 'agent_approval.approved'
      : 'agent_approval.rejected',
    target_type: 'agent_run',
    target_id: input.run.run_id,
    trace_id: input.trace_id ?? input.run.trace_id ?? input.run.state.trace_id,
    detail: {
      run_id: input.run.run_id,
      approval_id: input.approval_id,
      side_effect_class: found.side_effect_class ?? null,
      reason: found.reason ?? null,
      comment: input.comment ?? null,
    },
  });
  return state;
}

function updatePendingToolApprovalAfterDecision(input: {
  pending: NonNullable<AgentGraphState['runtime']>['pending_tool_approval'];
  approval_id: string;
  status: 'approved' | 'rejected';
  decided_at: string;
  comment?: string;
}): NonNullable<AgentGraphState['runtime']>['pending_tool_approval'] {
  if (!input.pending || input.pending.approval_id !== input.approval_id) {
    return input.pending;
  }
  return {
    ...input.pending,
    status: input.status,
    decided_at: input.decided_at,
    rejection_reason: input.status === 'rejected'
      ? input.comment ?? 'tool approval rejected'
      : undefined,
  };
}

export async function getAgentCostDashboard() {
  const [summary, byModel, byEntrypoint, recentRuns] = await Promise.all([
    queryOne(
      `
        SELECT
          count(*)::int AS llm_call_count,
          COALESCE(sum((token_usage->>'total_tokens')::int), 0)::int AS total_tokens,
          COALESCE(sum(estimated_cost_cents), 0)::text AS estimated_cost_cents,
          count(*) FILTER (WHERE status = 'blocked')::int AS blocked_calls,
          count(*) FILTER (WHERE status = 'failed')::int AS failed_calls
        FROM agent_llm_calls
      `,
    ),
    query(
      `
        SELECT
          model_name,
          count(*)::int AS call_count,
          COALESCE(sum((token_usage->>'total_tokens')::int), 0)::int AS total_tokens,
          COALESCE(sum(estimated_cost_cents), 0)::text AS estimated_cost_cents
        FROM agent_llm_calls
        GROUP BY model_name
        ORDER BY estimated_cost_cents DESC, call_count DESC
      `,
    ),
    query(
      `
        SELECT
          r.entrypoint,
          count(DISTINCT r.run_id)::int AS run_count,
          COALESCE(sum((c.token_usage->>'total_tokens')::int), 0)::int AS total_tokens,
          COALESCE(sum(c.estimated_cost_cents), 0)::text AS estimated_cost_cents
        FROM agent_runs r
        LEFT JOIN agent_llm_calls c ON c.run_id = r.run_id
        GROUP BY r.entrypoint
        ORDER BY estimated_cost_cents DESC, run_count DESC
      `,
    ),
    query(
      `
        SELECT *
        FROM agent_run_observability
        ORDER BY started_at DESC
        LIMIT 20
      `,
    ),
  ]);
  return {
    summary: summary ?? {
      llm_call_count: 0,
      total_tokens: 0,
      estimated_cost_cents: '0',
      blocked_calls: 0,
      failed_calls: 0,
    },
    by_model: byModel,
    by_entrypoint: byEntrypoint,
    recent_runs: recentRuns,
  };
}

function normalizeKillSwitchRow(row: {
  control_value?: Record<string, unknown>;
  updated_by?: string;
  reason?: string | null;
  updated_at?: string;
} | null | undefined) {
  const value = row?.control_value ?? {};
  return {
    enabled: value.enabled === true,
    scope: readScope(value.scope),
    reason: row?.reason ?? null,
    updated_by: row?.updated_by ?? null,
    updated_at: row?.updated_at ?? null,
  };
}

function readScope(value: unknown): AgentOpsControlInput['scope'] {
  return value === 'run_creation' ||
    value === 'llm' ||
    value === 'tool' ||
    value === 'resume'
    ? value
    : 'all';
}

function readControl(state: AgentGraphState): Record<string, unknown> {
  return state.control && typeof state.control === 'object' && !Array.isArray(state.control)
    ? state.control as Record<string, unknown>
    : {};
}

function readApprovalRequests(state: AgentGraphState): Array<Record<string, unknown>> {
  const requests = readControl(state).approval_requests;
  return Array.isArray(requests)
    ? requests.filter((request) => request && typeof request === 'object' && !Array.isArray(request)) as Array<Record<string, unknown>>
    : [];
}
