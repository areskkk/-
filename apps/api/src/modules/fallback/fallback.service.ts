import crypto from 'node:crypto';
import { ApiError } from '../../common/errors/http-error.js';
import {
  normalizePageQuery,
  pageResult,
  type PageQuery,
} from '../../common/pagination/pagination.js';
import { auditService } from '../audit/audit.service.js';
import { getCurrentAgentLease } from '../agents/runtime/agent-lease-context.js';
import {
  countFallbackTasks,
  findFallbackTaskById,
  insertFallbackTaskIfNotExists,
  listFallbackTasks,
  resolveFallbackTask,
} from './fallback.repository.js';
import {
  type CreateFallbackTaskInput,
  type FallbackResolutionType,
  type FallbackSourceType,
  type FallbackStatus,
  type ResolveFallbackTaskInput,
} from './fallback.types.js';

const RESOLUTION_TYPES = new Set<FallbackResolutionType>([
  'answer',
  'field_patch',
  'material_confirm',
  'close',
]);

const LISTABLE_STATUSES = new Set<FallbackStatus>([
  'pending',
  'processing',
  'resolved',
  'closed',
]);

const LISTABLE_SOURCE_TYPES = new Set<FallbackSourceType>([
  'policy_qa',
  'eligibility',
  'ocr',
  'rag_retrieval',
  'agent_run',
]);

const MAX_CONTEXT_KEYS = 20;
const MAX_ARRAY_ITEMS = 5;
const MAX_STRING_LENGTH = 300;
const MAX_CONTEXT_JSON_LENGTH = 4000;

function stableHash(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

export function normalizeQuestion(question: string): string {
  const normalized = question
    .trim()
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[，。！？；：（）【】《》“”‘’、,.!?;:()[\]{}"'`~|\\/_+=<>@#$%^&*-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (normalized !== '') {
    return normalized;
  }

  return question
    .trim()
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim();
}

export function createPolicyQaSourceId(input: {
  actor_id: string;
  question: string;
  policy_id?: string;
}): string {
  const normalizedQuestion = normalizeQuestion(input.question);
  return stableHash([
    'policy_qa',
    input.actor_id,
    input.policy_id ?? 'no_policy',
    normalizedQuestion,
  ].join(':'));
}

export function createEligibilitySourceId(input: {
  enterprise_id: string;
  policy_id: string;
  application_id?: string;
  item_id?: string;
}): string {
  if (input.application_id && input.item_id) {
    return stableHash([
      'eligibility',
      input.application_id,
      input.item_id,
    ].join(':'));
  }

  if (input.application_id) {
    return input.application_id;
  }

  return stableHash([
    'eligibility',
    input.enterprise_id,
    input.policy_id,
  ].join(':'));
}

export function createOcrSourceId(materialId: string): string {
  return materialId;
}

export function createRagRetrievalSourceId(input: {
  actor_id: string;
  query: string;
  policy_id?: string;
}): string {
  const normalizedQuery = normalizeQuestion(input.query);
  return stableHash([
    input.actor_id,
    normalizedQuery,
    input.policy_id ?? 'no_policy',
  ].join(':'));
}

function assertNonEmptyStableSource(
  sourceType: FallbackSourceType,
  sourceId: string,
  reason: string,
): void {
  if (!sourceType || !LISTABLE_SOURCE_TYPES.has(sourceType)) {
    throw new ApiError('VALIDATION_ERROR', 'invalid fallback source_type');
  }
  if (!sourceId || sourceId.trim() === '') {
    throw new ApiError('VALIDATION_ERROR', 'fallback source_id is required');
  }
  if (!reason || reason.trim() === '') {
    throw new ApiError('VALIDATION_ERROR', 'fallback reason is required');
  }
}

function truncateString(value: string): string {
  return value.length > MAX_STRING_LENGTH
    ? `${value.slice(0, MAX_STRING_LENGTH)}...`
    : value;
}

function summarizeValue(value: unknown, depth: number): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === 'string') {
    return truncateString(value);
  }

  if (
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((item) => summarizeValue(item, depth + 1));
  }

  if (typeof value === 'object') {
    if (depth >= 3) {
      return '[object summary omitted]';
    }

    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, MAX_CONTEXT_KEYS)
        .map(([key, item]) => [key, summarizeValue(item, depth + 1)]),
    );
  }

  return String(value);
}

function summarizeContext(
  context: Record<string, unknown>,
): Record<string, unknown> {
  const summarized = summarizeValue(context, 0) as Record<string, unknown>;
  const serialized = JSON.stringify(summarized);

  if (serialized.length <= MAX_CONTEXT_JSON_LENGTH) {
    return summarized;
  }

  return {
    summary_truncated: true,
    summary_hash: stableHash(serialized),
    summary_preview: serialized.slice(0, MAX_CONTEXT_JSON_LENGTH),
  };
}

export class FallbackService {
  async createIfNotExists(input: CreateFallbackTaskInput) {
    assertNonEmptyStableSource(
      input.source_type,
      input.source_id,
      input.reason,
    );

    const lease = getCurrentAgentLease();
    const result = await insertFallbackTaskIfNotExists({
      source_type: input.source_type,
      source_id: input.source_id,
      reason: input.reason,
      context: summarizeContext(input.context),
      run_id: input.run_id,
      job_id: input.job_id ?? lease?.job_id,
      worker_id: input.worker_id ?? lease?.worker_id,
    });

    if (result.created) {
      await auditService.write({
        actor_id: input.actor_id,
        action: 'fallback.task.create',
        target_type: 'fallback_task',
        target_id: result.task.task_id,
        trace_id: input.trace_id,
        detail: {
          source_type: result.task.source_type,
          source_id: result.task.source_id,
          reason: result.task.reason,
          status: result.task.status,
        },
      });
    }

    return {
      task: result.task,
      created: result.created,
    };
  }

  async list(queryInput: PageQuery & {
    status?: string;
    source_type?: string;
  }) {
    const normalized = normalizePageQuery(queryInput);
    const status = queryInput.status as FallbackStatus | undefined;
    const sourceType = queryInput.source_type as FallbackSourceType | undefined;

    if (status && !LISTABLE_STATUSES.has(status)) {
      throw new ApiError('VALIDATION_ERROR', 'invalid fallback task status');
    }

    if (sourceType && !LISTABLE_SOURCE_TYPES.has(sourceType)) {
      throw new ApiError('VALIDATION_ERROR', 'invalid fallback source_type');
    }

    const [items, total] = await Promise.all([
      listFallbackTasks({
        limit: normalized.page_size,
        offset: (normalized.page - 1) * normalized.page_size,
        status,
        source_type: sourceType,
      }),
      countFallbackTasks({
        status,
        source_type: sourceType,
      }),
    ]);

    return pageResult(items, total, normalized);
  }

  async getDetail(taskId: string) {
    if (!taskId) {
      throw new ApiError('VALIDATION_ERROR', 'task_id is required');
    }

    const task = await findFallbackTaskById(taskId);
    if (!task) {
      throw new ApiError('NOT_FOUND', 'fallback task not found');
    }

    return task;
  }

  async resolve(
    actorId: string,
    traceId: string,
    taskId: string,
    input: ResolveFallbackTaskInput,
  ) {
    if (!taskId) {
      throw new ApiError('VALIDATION_ERROR', 'task_id is required');
    }

    if (!RESOLUTION_TYPES.has(input.resolution_type)) {
      throw new ApiError('VALIDATION_ERROR', 'invalid resolution_type');
    }

    if (!input.comment || input.comment.trim() === '') {
      throw new ApiError('VALIDATION_ERROR', 'comment is required');
    }

    const existing = await findFallbackTaskById(taskId);
    if (!existing) {
      throw new ApiError('NOT_FOUND', 'fallback task not found');
    }

    if (existing.status !== 'pending') {
      throw new ApiError(
        'CONFLICT',
        'Batch 8 only supports pending fallback task resolution',
      );
    }

    const status = input.resolution_type === 'close' ? 'closed' : 'resolved';
    const resolved = await resolveFallbackTask({
      task_id: taskId,
      resolution_type: input.resolution_type,
      resolved_payload: {
        ...(input.resolved_payload ?? {}),
        comment: input.comment.trim(),
      },
      resolved_by: actorId,
      status,
    });

    if (!resolved) {
      throw new ApiError(
        'CONFLICT',
        'Batch 8 only supports pending fallback task resolution',
      );
    }

    await auditService.write({
      actor_id: actorId,
      action: 'fallback.task.resolve',
      target_type: 'fallback_task',
      target_id: taskId,
      trace_id: traceId,
      detail: {
        from_status: existing.status,
        to_status: resolved.status,
        source_type: resolved.source_type,
        source_id: resolved.source_id,
        reason: resolved.reason,
        resolution_type: resolved.resolution_type,
        comment: input.comment.trim(),
      },
    });

    return resolved;
  }
}

export const fallbackService = new FallbackService();
