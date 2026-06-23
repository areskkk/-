import { loadEnv } from '../../config/env.js';
import { query, queryOne } from '../../db/query.js';
import { LlmError } from './llm.types.js';

type ModelHealthRow = {
  request_count: number;
  error_count: number;
  rate_limit_count: number;
  latency_samples_ms: number[];
  circuit_open_until: string | null;
};

const MAX_LATENCY_SAMPLES = 100;
const MIN_REQUESTS_FOR_ERROR_CIRCUIT = 5;
const MIN_REQUESTS_FOR_LATENCY_CIRCUIT = 5;

export async function assertModelCircuitClosed(modelName: string): Promise<void> {
  if (!loadEnv().agentModelCircuitBreakerEnabled) {
    return;
  }
  const row = await queryOne<{ circuit_open_until: string | null }>(
    `
      SELECT circuit_open_until::text
      FROM agent_model_health
      WHERE model_name = $1
        AND circuit_open_until IS NOT NULL
      LIMIT 1
    `,
    [modelName],
  );
  if (!row?.circuit_open_until) {
    return;
  }
  if (new Date(row.circuit_open_until).getTime() <= Date.now()) {
    return;
  }
  {
    throw new LlmError({
      type: 'local_circuit_open',
      message: 'model circuit breaker is open',
      retryable: true,
      provider: 'bailian',
      model: modelName,
    });
  }
}

export async function recordModelCallSuccess(input: {
  model: string;
  latency_ms: number;
}): Promise<void> {
  if (!loadEnv().agentModelCircuitBreakerEnabled) {
    return;
  }
  await upsertModelHealth({
    model: input.model,
    latency_ms: input.latency_ms,
    is_error: false,
    is_rate_limit: false,
  });
}

export async function recordModelCallFailure(input: {
  model: string;
  latency_ms: number;
  error: unknown;
}): Promise<void> {
  if (!loadEnv().agentModelCircuitBreakerEnabled) {
    return;
  }
  const isRateLimit = input.error instanceof LlmError && input.error.type === 'rate_limit';
  const health = await upsertModelHealth({
    model: input.model,
    latency_ms: input.latency_ms,
    is_error: true,
    is_rate_limit: isRateLimit,
    last_error: sanitizeModelHealthError(input.error),
  });
  const openCircuit = shouldOpenCircuit(health);
  if (!openCircuit && !isRateLimit) {
    return;
  }
  await openModelCircuit({
    model: input.model,
    reason: isRateLimit ? 'rate_limit' : 'error_or_latency_threshold',
  });
}

async function upsertModelHealth(input: {
  model: string;
  latency_ms: number;
  is_error: boolean;
  is_rate_limit: boolean;
  last_error?: string;
}): Promise<ModelHealthRow> {
  const latencyMs = Math.max(0, Math.round(input.latency_ms));
  const row = await queryOne<{
    request_count: number;
    error_count: number;
    rate_limit_count: number;
    latency_samples_ms: number[];
    circuit_open_until: string | null;
  }>(
    `
      INSERT INTO agent_model_health (
        model_name,
        request_count,
        error_count,
        rate_limit_count,
        latency_samples_ms,
        last_error
      )
      VALUES (
        $1,
        1,
        CASE WHEN $3 THEN 1 ELSE 0 END,
        CASE WHEN $4 THEN 1 ELSE 0 END,
        jsonb_build_array($2::int),
        $5
      )
      ON CONFLICT (model_name) DO UPDATE
      SET
        window_started_at = CASE
          WHEN agent_model_health.window_started_at < now() - ($6::int * interval '1 millisecond')
            THEN now()
          ELSE agent_model_health.window_started_at
        END,
        request_count = CASE
          WHEN agent_model_health.window_started_at < now() - ($6::int * interval '1 millisecond')
            THEN 1
          ELSE agent_model_health.request_count + 1
        END,
        error_count = CASE
          WHEN agent_model_health.window_started_at < now() - ($6::int * interval '1 millisecond')
            THEN CASE WHEN $3 THEN 1 ELSE 0 END
          ELSE agent_model_health.error_count + CASE WHEN $3 THEN 1 ELSE 0 END
        END,
        rate_limit_count = CASE
          WHEN agent_model_health.window_started_at < now() - ($6::int * interval '1 millisecond')
            THEN CASE WHEN $4 THEN 1 ELSE 0 END
          ELSE agent_model_health.rate_limit_count + CASE WHEN $4 THEN 1 ELSE 0 END
        END,
        latency_samples_ms = (
          SELECT COALESCE(jsonb_agg(value), '[]'::jsonb)
          FROM (
            SELECT value
            FROM jsonb_array_elements(
              CASE
                WHEN agent_model_health.window_started_at < now() - ($6::int * interval '1 millisecond')
                  THEN jsonb_build_array($2::int)
                ELSE agent_model_health.latency_samples_ms || jsonb_build_array($2::int)
              END
            )
              WITH ORDINALITY samples(value, ordinal)
            ORDER BY ordinal DESC
            LIMIT ${MAX_LATENCY_SAMPLES}
          ) recent
        ),
        last_error = COALESCE($5, agent_model_health.last_error),
        circuit_open_until = CASE
          WHEN agent_model_health.circuit_open_until IS NOT NULL
            AND agent_model_health.circuit_open_until <= now()
            AND NOT $3
            THEN NULL
          ELSE agent_model_health.circuit_open_until
        END
      RETURNING
        request_count,
        error_count,
        rate_limit_count,
        latency_samples_ms,
        circuit_open_until::text
    `,
    [
      input.model,
      latencyMs,
      input.is_error,
      input.is_rate_limit,
      input.last_error ?? null,
      loadEnv().agentModelCircuitBreakerWindowMs,
    ],
  );
  return {
    request_count: Number(row?.request_count ?? 0),
    error_count: Number(row?.error_count ?? 0),
    rate_limit_count: Number(row?.rate_limit_count ?? 0),
    latency_samples_ms: Array.isArray(row?.latency_samples_ms)
      ? row.latency_samples_ms.map(Number)
      : [],
    circuit_open_until: row?.circuit_open_until ?? null,
  };
}

function shouldOpenCircuit(health: ModelHealthRow): boolean {
  const env = loadEnv();
  if (health.request_count >= MIN_REQUESTS_FOR_ERROR_CIRCUIT) {
    const errorRate = health.error_count / health.request_count;
    if (errorRate >= env.agentModelErrorRateThreshold) {
      return true;
    }
  }
  if (health.request_count < MIN_REQUESTS_FOR_LATENCY_CIRCUIT) {
    return false;
  }
  return percentile(health.latency_samples_ms, 0.95) >= env.agentModelP95LatencyMs;
}

async function openModelCircuit(input: {
  model: string;
  reason: string;
}): Promise<void> {
  await query(
    `
      UPDATE agent_model_health
      SET
        circuit_open_until = now() + ($2::int * interval '1 millisecond'),
        last_error = $3
      WHERE model_name = $1
    `,
    [input.model, loadEnv().agentModelCircuitBreakerOpenMs, input.reason],
  );
}

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1);
  return sorted[index] ?? 0;
}

function sanitizeModelHealthError(error: unknown): string {
  if (error instanceof LlmError) {
    return error.type;
  }
  if (error instanceof Error) {
    return error.name;
  }
  return 'unknown_error';
}
