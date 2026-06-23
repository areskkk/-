import { ApiError } from '../../../common/errors/http-error.js';
import { loadEnv } from '../../../config/env.js';
import {
  attachQuotaReservationToRun,
  assertRunLeaseActiveByRunId,
  countActiveQuotaReservationsByActor,
  countActiveRunsByActor,
  countActiveRunsGlobal,
  countRunsByActorSince,
  countRunsByEnterpriseSince,
  getModelPrice,
  insertLlmCallRecord,
  releaseQuotaReservation,
  reserveDailyLlmBudget,
  reserveAgentQuota,
  settleDailyLlmBudgetReservation,
  sumDailyTokenUsage,
  sumDailyLlmCostCents,
  sumDailyReservedLlmCostCents,
  sumDailySettledLlmCostCents,
  sumRunLlmTokenUsage,
  sumRunLlmCostCents,
  sumRunTokenUsage,
} from '../agents.repository.js';
import { type AgentRunRow } from '../agents.types.js';
import { findApplicationAgentContext } from './application-context.repository.js';
import { findReviewTaskByItemId } from '../../review/review.repository.js';
import { auditService } from '../../audit/audit.service.js';
import { type LlmChatRequest, type LlmChatResponse, type LlmTokenUsage } from '../../llm/llm.types.js';
import { getCurrentAgentLease } from './agent-lease-context.js';

const CENTS_PER_1K_TOKENS_FALLBACK = 0.01;

export async function assertCanCreateAgentRun(input: {
  actor_id: string;
  entrypoint?: string;
  body_input: Record<string, unknown>;
  reserve?: boolean;
}): Promise<{ enterprise_id?: string }> {
  const env = loadEnv();
  const dayStart = startOfUtcDay();
  const enterpriseId = await resolveEnterpriseId({
    entrypoint: input.entrypoint,
    body_input: input.body_input,
  });
  const [userDaily, userActive, globalActive, dailyTokens] = await Promise.all([
    countRunsByActorSince({ actor_id: input.actor_id, since: dayStart }),
    countActiveQuotaReservationsByActor(input.actor_id),
    countActiveRunsGlobal(),
    sumDailyTokenUsage(dayStart),
  ]);

  if (userDaily >= env.agentRateLimitPerUserPerDay) {
    throw new ApiError('RATE_LIMITED', 'agent daily user rate limit exceeded', {
      limit_type: 'user_per_day',
      retry_after: nextUtcDayIso(),
    });
  }
  if (userActive >= env.agentMaxConcurrentRunsPerUser) {
    throw new ApiError('RATE_LIMITED', 'agent user concurrency limit exceeded', {
      limit_type: 'user_concurrency',
    });
  }
  if (globalActive >= env.agentMaxConcurrentRunsGlobal) {
    throw new ApiError('RATE_LIMITED', 'agent global concurrency limit exceeded', {
      limit_type: 'global_concurrency',
    });
  }

  if (enterpriseId) {
    const enterpriseDaily = await countRunsByEnterpriseSince({
      enterprise_id: enterpriseId,
      since: dayStart,
    });
    if (enterpriseDaily >= env.agentRateLimitPerEnterprisePerDay) {
      throw new ApiError('RATE_LIMITED', 'agent enterprise daily rate limit exceeded', {
        limit_type: 'enterprise_per_day',
        retry_after: nextUtcDayIso(),
      });
    }
  }

  const estimatedDailyCost = Math.max(
    estimateCostCents(dailyTokens),
    (await sumDailyLlmCostCents(dayStart)) + (await sumDailyReservedLlmCostCents()),
  );
  if (estimatedDailyCost >= env.agentMaxDailyCostCents) {
    throw new ApiError('RATE_LIMITED', 'agent daily cost budget exceeded', {
      limit_type: 'daily_cost_budget',
      retry_after: nextUtcDayIso(),
    });
  }

  if (input.reserve) {
    try {
      await reserveAgentQuota({
        actor_id: input.actor_id,
        enterprise_id: enterpriseId,
        max_concurrent_per_user: env.agentMaxConcurrentRunsPerUser,
        max_concurrent_global: env.agentMaxConcurrentRunsGlobal,
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'AGENT_USER_CONCURRENCY_LIMIT') {
        throw new ApiError('RATE_LIMITED', 'agent user concurrency limit exceeded', {
          limit_type: 'user_concurrency',
        });
      }
      if (error instanceof Error && error.message === 'AGENT_GLOBAL_CONCURRENCY_LIMIT') {
        throw new ApiError('RATE_LIMITED', 'agent global concurrency limit exceeded', {
          limit_type: 'global_concurrency',
        });
      }
      throw error;
    }
  }

  return { enterprise_id: enterpriseId };
}

export async function attachRunQuotaReservation(input: {
  actor_id: string;
  run_id: string;
}): Promise<void> {
  await attachQuotaReservationToRun(input);
}

export async function releaseRunQuotaReservation(runId: string): Promise<void> {
  await releaseQuotaReservation(runId);
}

export async function assertRunBudgetAvailable(
  run: AgentRunRow,
  estimate?: {
    model: string;
    max_tokens: number;
  },
): Promise<void> {
  await assertRunBudgetAvailableByRunId(run.run_id, estimate);
}

async function assertRunBudgetAvailableByRunId(
  runId: string,
  estimate?: {
    model: string;
    max_tokens: number;
  },
): Promise<void> {
  const env = loadEnv();
  const usedTokens = Math.max(
    await sumRunTokenUsage(runId),
    await sumRunLlmTokenUsage(runId),
  );
  const projectedTokens = usedTokens + (estimate ? estimate.max_tokens * 2 : 0);
  if (projectedTokens >= env.agentMaxRunTokens) {
    throw new ApiError('RATE_LIMITED', 'agent run token budget exceeded', {
      limit_type: 'run_token_budget',
      run_id: runId,
    });
  }
  const usedCost = await sumRunLlmCostCents(runId);
  const projectedCost = usedCost + (
    estimate ? await estimateModelCostCents({
      model: estimate.model,
      prompt_tokens: estimate.max_tokens,
      completion_tokens: estimate.max_tokens,
    }) : 0
  );
  if (projectedCost >= env.agentMaxRunCostCents) {
    throw new ApiError('RATE_LIMITED', 'agent run cost budget exceeded', {
      limit_type: 'run_cost_budget',
      run_id: runId,
    });
  }
}

export async function assertLlmBudgetBeforeCall(
  request: LlmChatRequest,
): Promise<void> {
  if (!request.run_id) {
    return;
  }
  const maxTokens = request.estimated_max_tokens ?? loadEnv().agentLlmEstimatedMaxTokens;
  await assertRunBudgetAvailableByRunId(request.run_id, {
    model: request.model,
    max_tokens: maxTokens,
  });
}

export async function reserveLlmBudgetBeforeCall(
  request: LlmChatRequest,
): Promise<string | undefined> {
  if (!request.run_id) {
    return undefined;
  }
  const env = loadEnv();
  const lease = getCurrentAgentLease();
  if (!(await assertRunLeaseActiveByRunId({
    run_id: request.run_id,
    job_id: lease?.job_id,
    worker_id: lease?.worker_id,
  }))) {
    throw new ApiError('CONFLICT', 'agent run worker lease lost before llm call', {
      run_id: request.run_id,
    });
  }
  const maxTokens = request.estimated_max_tokens ?? env.agentLlmEstimatedMaxTokens;
  await assertRunBudgetAvailableByRunId(request.run_id, {
    model: request.model,
    max_tokens: maxTokens,
  });
  const reservedCost = await estimateModelCostCents({
    model: request.model,
    prompt_tokens: maxTokens,
    completion_tokens: maxTokens,
  });
  try {
    return await reserveDailyLlmBudget({
      run_id: request.run_id,
      trace_id: request.trace_id,
      model_name: request.model,
      reserved_tokens: maxTokens * 2,
      reserved_cost_cents: reservedCost,
      max_daily_cost_cents: env.agentMaxDailyCostCents,
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'AGENT_DAILY_COST_BUDGET_LIMIT') {
      throw new ApiError('RATE_LIMITED', 'agent daily cost budget exceeded', {
        limit_type: 'daily_cost_budget',
        retry_after: nextUtcDayIso(),
      });
    }
    throw error;
  }
}

export async function settleLlmBudgetAfterCall(input: {
  reservation_id?: string;
  usage?: LlmTokenUsage | null;
  model: string;
  released?: boolean;
}): Promise<void> {
  if (!input.reservation_id) {
    return;
  }
  const actualCost = input.usage
    ? await estimateModelCostCents({
      model: input.model,
      prompt_tokens: input.usage.prompt_tokens,
      completion_tokens: input.usage.completion_tokens,
    })
    : 0;
  await settleDailyLlmBudgetReservation({
    reservation_id: input.reservation_id,
    actual_tokens: input.usage?.total_tokens ?? 0,
    actual_cost_cents: actualCost,
    released: input.released ?? false,
  });
  if (!input.released && actualCost > 0) {
    await auditDailyBudgetOverrunIfNeeded(actualCost);
  }
}

export async function recordLlmCall(input: {
  request: LlmChatRequest;
  response?: LlmChatResponse;
  status: 'completed' | 'failed' | 'blocked';
  latency_ms?: number;
  error_type?: string;
}): Promise<void> {
  const usage = input.response?.usage ?? null;
  const estimatedCost = usage
    ? await estimateModelCostCents({
      model: input.request.model,
      prompt_tokens: usage.prompt_tokens,
      completion_tokens: usage.completion_tokens,
    })
    : 0;
  await insertLlmCallRecord({
    run_id: input.request.run_id,
    trace_id: input.request.trace_id,
    agent_type: input.request.agent_type,
    model_name: input.request.model,
    prompt_version: input.request.prompt_version,
    status: input.status,
    token_usage: usageToRecord(usage),
    estimated_cost_cents: estimatedCost,
    latency_ms: input.latency_ms,
    error_type: input.error_type,
  });
  await auditService.write({
    actor_id: 'system',
    action: input.status === 'completed'
      ? 'llm.chat.completed'
      : input.status === 'blocked'
        ? 'llm.chat.blocked'
        : 'llm.chat.failed',
    target_type: 'agent_llm_call',
    target_id: input.request.run_id ?? input.request.trace_id ?? input.request.model,
    trace_id: input.request.trace_id,
    detail: {
      run_id: input.request.run_id ?? null,
      model: input.request.model,
      prompt_version: input.request.prompt_version ?? null,
      agent_type: input.request.agent_type ?? null,
      status: input.status,
      token_usage: usageToRecord(usage),
      estimated_cost_cents: estimatedCost,
      latency_ms: input.latency_ms ?? null,
      error_type: input.error_type ?? null,
    },
  });
}

export async function estimateModelCostCents(input: {
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
}): Promise<number> {
  const price = await getModelPrice(input.model);
  if (!price) {
    return estimateCostCents(input.prompt_tokens + input.completion_tokens);
  }
  return (
    (input.prompt_tokens / 1000) * price.input_cents_per_1k +
    (input.completion_tokens / 1000) * price.output_cents_per_1k
  );
}

export async function resolveEnterpriseId(input: {
  entrypoint?: string;
  body_input: Record<string, unknown>;
}): Promise<string | undefined> {
  if (input.entrypoint === 'application') {
    const applicationId = readString(input.body_input.application_id);
    if (!applicationId) {
      return undefined;
    }
    return (await findApplicationAgentContext(
      applicationId,
      readString(input.body_input.item_id),
    ))?.enterprise_id;
  }
  if (input.entrypoint === 'review') {
    const itemId = readString(input.body_input.item_id);
    if (!itemId) {
      return undefined;
    }
    return (await findReviewTaskByItemId(itemId))?.enterprise_id;
  }
  return readString(input.body_input.enterprise_id);
}

function estimateCostCents(tokens: number): number {
  return (tokens / 1000) * CENTS_PER_1K_TOKENS_FALLBACK;
}

function usageToRecord(usage: LlmTokenUsage | null): Record<string, unknown> {
  return usage
    ? {
      prompt_tokens: usage.prompt_tokens,
      completion_tokens: usage.completion_tokens,
      total_tokens: usage.total_tokens,
    }
    : {};
}

function startOfUtcDay(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function nextUtcDayIso(): string {
  const start = startOfUtcDay();
  start.setUTCDate(start.getUTCDate() + 1);
  return start.toISOString();
}

async function auditDailyBudgetOverrunIfNeeded(actualCost: number): Promise<void> {
  const env = loadEnv();
  const dailyCost = Math.max(
    await sumDailyLlmCostCents(startOfUtcDay()),
    await sumDailySettledLlmCostCents(),
  );
  if (dailyCost <= env.agentMaxDailyCostCents) {
    return;
  }
  await auditService.write({
    actor_id: 'system',
    action: 'llm.daily_budget.overrun',
    target_type: 'agent_daily_budget',
    target_id: startOfUtcDay().toISOString().slice(0, 10),
    detail: {
      daily_cost_cents: dailyCost,
      max_daily_cost_cents: env.agentMaxDailyCostCents,
      latest_actual_cost_cents: actualCost,
      retry_after: nextUtcDayIso(),
    },
  });
}

function readString(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') {
    return undefined;
  }
  return value.trim();
}
