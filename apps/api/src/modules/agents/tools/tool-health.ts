import { ApiError } from '../../../common/errors/http-error.js';
import { loadEnv } from '../../../config/env.js';
import { query, queryOne } from '../../../db/query.js';
import { auditService } from '../../audit/audit.service.js';
import { type AgentToolError, type AgentToolName } from './tool.types.js';

const MAX_LATENCY_SAMPLES = 100;
const MIN_REQUESTS_FOR_ERROR_CIRCUIT = 5;

export async function assertToolCircuitClosed(input: {
  tool_name: AgentToolName;
  run_id?: string;
  trace_id?: string;
}): Promise<void> {
  const row = await queryOne<{ circuit_open_until: string | null }>(
    `
      SELECT circuit_open_until::text
      FROM agent_tool_health
      WHERE tool_name = $1
        AND circuit_open_until IS NOT NULL
      LIMIT 1
    `,
    [input.tool_name],
  );
  if (!row?.circuit_open_until) {
    return;
  }
  if (new Date(row.circuit_open_until).getTime() <= Date.now()) {
    return;
  }
  await auditService.write({
    actor_id: 'system',
    action: 'agent_tool.circuit.blocked',
    target_type: 'agent_tool',
    target_id: input.tool_name,
    trace_id: input.trace_id,
    detail: {
      run_id: input.run_id ?? null,
      tool_name: input.tool_name,
      circuit_open_until: row.circuit_open_until,
    },
  });
  throw new ApiError('RATE_LIMITED', 'agent tool circuit breaker is open', {
    tool_name: input.tool_name,
    retry_after: row.circuit_open_until,
  });
}

export async function recordToolCallSuccess(input: {
  tool_name: AgentToolName;
  latency_ms: number;
}): Promise<void> {
  await upsertToolHealth({
    tool_name: input.tool_name,
    latency_ms: input.latency_ms,
    is_error: false,
  });
}

export async function recordToolCallFailure(input: {
  tool_name: AgentToolName;
  latency_ms: number;
  error: AgentToolError;
}): Promise<void> {
  const health = await upsertToolHealth({
    tool_name: input.tool_name,
    latency_ms: input.latency_ms,
    is_error: true,
    last_error: input.error.type,
  });
  if (!health) {
    return;
  }
  if (health.request_count < MIN_REQUESTS_FOR_ERROR_CIRCUIT) {
    return;
  }
  const errorRate = health.error_count / health.request_count;
  if (errorRate < loadEnv().agentModelErrorRateThreshold) {
    return;
  }
  await openToolCircuit({
    tool_name: input.tool_name,
    reason: 'error_threshold',
  });
}

export async function resetToolCircuit(input: {
  actor_id: string;
  trace_id?: string;
  tool_name: AgentToolName;
}) {
  const row = await queryOne(
    `
      INSERT INTO agent_tool_health (tool_name)
      VALUES ($1)
      ON CONFLICT (tool_name) DO UPDATE
      SET
        circuit_open_until = NULL,
        error_count = 0,
        last_error = NULL
      RETURNING
        tool_name,
        request_count,
        error_count,
        circuit_open_until::text,
        last_error,
        updated_at::text
    `,
    [input.tool_name],
  );
  await auditService.write({
    actor_id: input.actor_id,
    action: 'agent_tool.circuit.reset',
    target_type: 'agent_tool',
    target_id: input.tool_name,
    trace_id: input.trace_id,
    detail: {
      tool_name: input.tool_name,
    },
  });
  return row;
}

async function upsertToolHealth(input: {
  tool_name: AgentToolName;
  latency_ms: number;
  is_error: boolean;
  last_error?: string;
}) {
  const latencyMs = Math.max(0, Math.round(input.latency_ms));
  return queryOne<{
    request_count: number;
    error_count: number;
    circuit_open_until: string | null;
  }>(
    `
      INSERT INTO agent_tool_health (
        tool_name,
        request_count,
        error_count,
        latency_samples_ms,
        last_error
      )
      VALUES (
        $1,
        1,
        CASE WHEN $3 THEN 1 ELSE 0 END,
        jsonb_build_array($2::int),
        $4
      )
      ON CONFLICT (tool_name) DO UPDATE
      SET
        window_started_at = CASE
          WHEN agent_tool_health.window_started_at < now() - ($5::int * interval '1 millisecond')
            THEN now()
          ELSE agent_tool_health.window_started_at
        END,
        request_count = CASE
          WHEN agent_tool_health.window_started_at < now() - ($5::int * interval '1 millisecond')
            THEN 1
          ELSE agent_tool_health.request_count + 1
        END,
        error_count = CASE
          WHEN agent_tool_health.window_started_at < now() - ($5::int * interval '1 millisecond')
            THEN CASE WHEN $3 THEN 1 ELSE 0 END
          ELSE agent_tool_health.error_count + CASE WHEN $3 THEN 1 ELSE 0 END
        END,
        latency_samples_ms = (
          SELECT COALESCE(jsonb_agg(value), '[]'::jsonb)
          FROM (
            SELECT value
            FROM jsonb_array_elements(
              CASE
                WHEN agent_tool_health.window_started_at < now() - ($5::int * interval '1 millisecond')
                  THEN jsonb_build_array($2::int)
                ELSE agent_tool_health.latency_samples_ms || jsonb_build_array($2::int)
              END
            )
              WITH ORDINALITY samples(value, ordinal)
            ORDER BY ordinal DESC
            LIMIT ${MAX_LATENCY_SAMPLES}
          ) recent
        ),
        last_error = COALESCE($4, agent_tool_health.last_error),
        circuit_open_until = CASE
          WHEN agent_tool_health.circuit_open_until IS NOT NULL
            AND agent_tool_health.circuit_open_until <= now()
            AND NOT $3
            THEN NULL
          ELSE agent_tool_health.circuit_open_until
        END
      RETURNING
        request_count,
        error_count,
        circuit_open_until::text
    `,
    [
      input.tool_name,
      latencyMs,
      input.is_error,
      input.last_error ?? null,
      loadEnv().agentModelCircuitBreakerWindowMs,
    ],
  );
}

async function openToolCircuit(input: {
  tool_name: AgentToolName;
  reason: string;
}): Promise<void> {
  await query(
    `
      UPDATE agent_tool_health
      SET
        circuit_open_until = now() + ($2::int * interval '1 millisecond'),
        last_error = $3
      WHERE tool_name = $1
    `,
    [input.tool_name, loadEnv().agentModelCircuitBreakerOpenMs, input.reason],
  );
}
