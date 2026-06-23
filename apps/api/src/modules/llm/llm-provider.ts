import { bailianLlmClient } from './bailian.client.js';
import { loadEnv } from '../../config/env.js';
import {
  recordLlmCall,
  reserveLlmBudgetBeforeCall,
  settleLlmBudgetAfterCall,
} from '../agents/runtime/agent-runtime-controls.js';
import { assertAgentKillSwitchOpen } from '../agents/runtime/agent-ops-control.js';
import { sanitizeLlmMessages } from '../agents/runtime/agent-security.js';
import {
  assertModelCircuitClosed,
  recordModelCallFailure,
  recordModelCallSuccess,
} from './model-health.js';
import {
  LlmError,
  type LlmChatRequest,
  type LlmChatResponse,
  type LlmClient,
} from './llm.types.js';

let activeLlmClient: LlmClient = bailianLlmClient;

export function getLlmClient(): LlmClient {
  return meteredLlmClient;
}

export function setLlmClientForTesting(client: LlmClient): void {
  activeLlmClient = client;
}

export function resetLlmClientForTesting(): void {
  activeLlmClient = bailianLlmClient;
}

const meteredLlmClient: LlmClient = {
  async chatCompletion<TJson = unknown>(
    request: LlmChatRequest,
  ): Promise<LlmChatResponse<TJson>> {
    const safeRequest = {
      ...request,
      messages: sanitizeLlmMessages(request.messages),
    };
    let runnableRequest = safeRequest;
    let budgetReservationId: string | undefined;
    const startedAt = Date.now();
    try {
      await assertAgentKillSwitchOpen({
        scope: 'llm',
        run_id: safeRequest.run_id,
        model_name: safeRequest.model,
      });
      runnableRequest = await resolveRunnableRequest(safeRequest);
      budgetReservationId = await reserveLlmBudgetBeforeCall(runnableRequest);
      const response = await activeLlmClient.chatCompletion<TJson>(runnableRequest);
      await bestEffortRecordModelCallSuccess({
        model: runnableRequest.model,
        latency_ms: Date.now() - startedAt,
      });
      await persistSuccessfulCall(runnableRequest, response, budgetReservationId, startedAt);
      return response;
    } catch (error) {
      await bestEffortSettleBudget({
        reservation_id: budgetReservationId,
        model: runnableRequest.model,
        released: true,
      });
      if (
        !(error instanceof LlmError && error.type === 'local_circuit_open') &&
        !isLocalBlockedError(error)
      ) {
        await bestEffortRecordModelCallFailure({
          model: runnableRequest.model,
          latency_ms: Date.now() - startedAt,
          error,
        });
      }
      await bestEffortRecordLlmCall({
        request: runnableRequest,
        status: error instanceof LlmError && error.type === 'local_circuit_open'
          ? 'blocked'
          : isLocalBlockedError(error)
            ? 'blocked'
            : 'failed',
        latency_ms: Date.now() - startedAt,
        error_type: readLlmErrorType(error),
      });
      throw error;
    }
  },
};

async function persistSuccessfulCall<TJson>(
  request: LlmChatRequest,
  response: LlmChatResponse<TJson>,
  budgetReservationId: string | undefined,
  startedAt: number,
): Promise<void> {
  await bestEffortSettleBudget({
    reservation_id: budgetReservationId,
    model: request.model,
    usage: response.usage,
  });
  await bestEffortRecordLlmCall({
    request,
    response,
    status: 'completed',
    latency_ms: Date.now() - startedAt,
  });
}

async function bestEffortSettleBudget(input: {
  reservation_id?: string;
  model: string;
  usage?: LlmChatResponse['usage'];
  released?: boolean;
}): Promise<void> {
  try {
    await settleLlmBudgetAfterCall(input);
  } catch {
    // Provider success/failure must not be reclassified because metering persistence failed.
  }
}

async function bestEffortRecordLlmCall(input: Parameters<typeof recordLlmCall>[0]): Promise<void> {
  try {
    await recordLlmCall(input);
  } catch {
    // Audit persistence is best-effort; do not mutate model health or agent outcome here.
  }
}

async function bestEffortRecordModelCallSuccess(
  input: Parameters<typeof recordModelCallSuccess>[0],
): Promise<void> {
  try {
    await recordModelCallSuccess(input);
  } catch {
    // Provider success must not fail because model-health persistence failed.
  }
}

async function bestEffortRecordModelCallFailure(
  input: Parameters<typeof recordModelCallFailure>[0],
): Promise<void> {
  try {
    await recordModelCallFailure(input);
  } catch {
    // Provider/local failure classification must not depend on health persistence.
  }
}

function isLocalBlockedError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  if (error.name !== 'ApiError') {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return code === 'RATE_LIMITED' || code === 'FORBIDDEN' || code === 'AUTH_REQUIRED';
}

function readLlmErrorType(error: unknown): string {
  if (error instanceof LlmError) {
    return error.type;
  }
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : 'local_blocked';
  }
  return 'unknown_error';
}

async function resolveRunnableRequest(request: LlmChatRequest): Promise<LlmChatRequest> {
  try {
    await assertModelCircuitClosed(request.model);
    return request;
  } catch (error) {
    if (
      !(error instanceof LlmError) ||
      error.type !== 'local_circuit_open' ||
      !loadEnv().agentFallbackModelEnabled ||
      !loadEnv().agentFallbackModelDefault
    ) {
      throw error;
    }
    const fallbackRequest = {
      ...request,
      model: loadEnv().agentFallbackModelDefault as string,
    };
    await assertModelCircuitClosed(fallbackRequest.model);
    return fallbackRequest;
  }
}
