import { ApiError } from '../../common/errors/http-error.js';
import {
  normalizePageQuery,
  pageResult,
  type PageQuery,
} from '../../common/pagination/pagination.js';
import { auditService } from '../audit/audit.service.js';
import {
  applyReviewDecisionInTransaction,
  applyReviewPrecheckInTransaction,
  applySupplementRequestInTransaction,
  countPolicyItemsByApplicationId,
  countReviewTasks,
  findProfileSnapshotById,
  findReviewTaskByItemId,
  getReviewTaskStatuses,
  listReviewMaterialsByApplicationId,
  listReviewRecordsByItemId,
  listReviewTasks,
  type ReviewDecision,
  type ReviewTaskDetailRow,
  type ReviewTaskRow,
} from './review.repository.js';
import { buildGovernmentOcrEvidence } from '../ocr/ocr-summary.js';
import {
  findReviewAgentDraftById,
  listReviewAgentDraftsByItemId,
  updateReviewAgentDraftHandling,
  type ReviewAgentDraftAction,
} from './review-agent-drafts.repository.js';

export type ReviewDecisionRequest = {
  decision: ReviewDecision;
  comment?: string;
};

export type ReviewPrecheckRequest = {
  idempotency_key?: string;
  comment?: string;
};

export type SupplementRequest = {
  idempotency_key?: string;
  reason: string;
  deadline_at?: string;
  required_materials?: Array<Record<string, unknown>>;
  field_requirements?: Array<Record<string, unknown>>;
};

export type HandleReviewAgentDraftRequest = {
  action: ReviewAgentDraftAction;
  comment?: string;
  revised_opinion?: string;
};

type ReviewTaskListQuery = PageQuery & {
  status?: string;
};

const DECISION_TARGET = {
  approve: {
    target_status: 'approved',
    review_result: 'approved',
  },
  reject: {
    target_status: 'rejected',
    review_result: 'rejected',
  },
  request_supplement: {
    target_status: 'need_supplement',
    review_result: 'need_supplement',
  },
} satisfies Record<ReviewDecision, { target_status: string; review_result: string }>;

const DECISION_ALLOWED_STATUSES = new Set([
  'submitted',
  'pre_reviewing',
  'resubmitted',
  'reviewing',
  'manual_review',
]);

function assertDecision(decision: string): asserts decision is ReviewDecision {
  if (!['approve', 'reject', 'request_supplement'].includes(decision)) {
    throw new ApiError(
      'VALIDATION_ERROR',
      'decision must be approve, reject or request_supplement',
    );
  }
}

function formatTask(row: ReviewTaskRow) {
  return {
    item_id: row.item_id,
    application_id: row.application_id,
    application_status: row.application_status,
    policy_item_status: row.policy_item_status,
    review_result: row.review_result,
    enterprise: {
      enterprise_id: row.enterprise_id,
      name: row.enterprise_name,
    },
    policy: {
      policy_id: row.policy_id,
      title: row.policy_title,
      version: row.policy_version,
    },
    current_department_id: row.current_department_id,
    submit_time: row.submit_time,
    deadline_at: row.deadline_at,
    created_at: row.created_at,
  };
}

function formatTaskBase(row: ReviewTaskDetailRow) {
  return {
    item_id: row.item_id,
    application_id: row.application_id,
    applicant_user_id: row.applicant_user_id,
    profile_snapshot_id: row.profile_snapshot_id,
    application_status: row.application_status,
    policy_item_status: row.policy_item_status,
    review_result: row.review_result,
    enterprise: {
      enterprise_id: row.enterprise_id,
      name: row.enterprise_name,
    },
    policy: {
      policy_id: row.policy_id,
      title: row.policy_title,
      version: row.policy_version,
      status: row.policy_status,
      content: row.policy_content,
    },
    current_department_id: row.current_department_id,
    submit_time: row.submit_time,
    deadline_at: row.deadline_at,
    created_at: row.created_at,
  };
}

function assertDraftAction(action: string): asserts action is ReviewAgentDraftAction {
  if (!['adopt', 'revise', 'ignore'].includes(action)) {
    throw new ApiError(
      'VALIDATION_ERROR',
      'action must be adopt, revise or ignore',
    );
  }
}

export class ReviewService {
  async listTasks(queryInput: ReviewTaskListQuery) {
    const normalized = normalizePageQuery(queryInput);
    const allowedStatuses = getReviewTaskStatuses();
    const statuses = queryInput.status
      ? allowedStatuses.filter((status) => status === queryInput.status)
      : allowedStatuses;

    if (statuses.length === 0) {
      return pageResult([], 0, normalized);
    }

    const [items, total] = await Promise.all([
      listReviewTasks({
        statuses,
        limit: normalized.page_size,
        offset: (normalized.page - 1) * normalized.page_size,
      }),
      countReviewTasks(statuses),
    ]);

    return pageResult(items.map(formatTask), total, normalized);
  }

  async getTaskDetail(itemId: string) {
    if (!itemId) {
      throw new ApiError('VALIDATION_ERROR', 'item_id is required');
    }

    const task = await findReviewTaskByItemId(itemId);
    if (!task) {
      throw new ApiError('NOT_FOUND', 'review task not found');
    }

    const [profileSnapshot, materials, reviewRecords, agentDrafts] = await Promise.all([
      task.profile_snapshot_id
        ? findProfileSnapshotById(task.profile_snapshot_id)
        : Promise.resolve(undefined),
      listReviewMaterialsByApplicationId(task.application_id),
      listReviewRecordsByItemId(itemId),
      listReviewAgentDraftsByItemId(itemId),
    ]);

    return {
      task: formatTaskBase(task),
      profile_snapshot: profileSnapshot ?? null,
      materials: materials.map((material) => ({
        material_id: material.material_id,
        item_id: material.policy_item_id,
        material_type: material.material_type,
        file_id: material.file_id,
        original_filename: material.original_filename,
        mime_type: material.mime_type,
        byte_size: Number(material.byte_size),
        file_hash: material.file_hash,
        issue_date: material.issue_date,
        expire_date: material.expire_date,
        ocr_status: material.ocr_status,
        ocr_evidence: buildGovernmentOcrEvidence({
          material_type: material.material_type,
          ocr_status: material.ocr_status,
          ocr_result_id: material.ocr_result_id,
          fields: material.ocr_fields,
          field_confidence: material.field_confidence,
          overall_confidence: material.overall_confidence === null
            ? null
            : Number(material.overall_confidence),
          warnings: material.warnings,
          requires_manual_confirmation: material.requires_manual_confirmation,
        }),
        security_level: material.security_level,
        is_current: true,
        created_at: material.created_at,
      })),
      review_records: reviewRecords,
      agent_assist_disclaimer:
        'AI 辅助意见仅供参考，最终审核结论以人工审核为准；采纳、修改或忽略草稿均不会自动调用 review.decide。',
      agent_drafts: agentDrafts.map((draft) => ({
        ...draft,
        responsibility_boundary: {
          notice: 'AI 辅助意见仅供参考，最终审核结论以人工审核为准。',
          no_auto_approval: true,
          adoption_is_not_decision: true,
          run_id: draft.run_id,
          generated_at: draft.created_at,
          model_names: readDraftModelNames(draft.agent_outputs),
          risk_items: draft.risk_items,
          missing_evidence: draft.missing_evidence,
        },
      })),
    };
  }

  async handleAgentDraft(
    actorId: string,
    traceId: string,
    draftId: string,
    input: HandleReviewAgentDraftRequest,
  ) {
    if (!draftId) {
      throw new ApiError('VALIDATION_ERROR', 'draft_id is required');
    }

    assertDraftAction(input.action);
    const comment = input.comment?.trim() || null;
    const revisedOpinion = input.revised_opinion?.trim() || null;

    if (input.action === 'revise' && !revisedOpinion) {
      throw new ApiError(
        'VALIDATION_ERROR',
        'revised_opinion is required when revising an agent draft',
      );
    }

    const draft = await findReviewAgentDraftById(draftId);
    if (!draft) {
      throw new ApiError('NOT_FOUND', 'review agent draft not found');
    }

    if (draft.status !== 'generated') {
      throw new ApiError(
        'CONFLICT',
        'only generated review agent drafts can be handled',
      );
    }

    const status = {
      adopt: 'adopted',
      revise: 'revised',
      ignore: 'ignored',
    }[input.action] as 'adopted' | 'revised' | 'ignored';

    const updated = await updateReviewAgentDraftHandling({
      draft_id: draftId,
      status,
      handled_by: actorId,
      handled_action: input.action,
      handled_comment: comment,
      revised_opinion: revisedOpinion,
    });
    if (!updated) {
      throw new ApiError(
        'CONFLICT',
        'only generated review agent drafts can be handled',
      );
    }

    await auditService.write({
      actor_id: actorId,
      action: `review.agent_draft.${input.action}`,
      target_type: 'review_agent_draft',
      target_id: draftId,
      trace_id: traceId,
      detail: {
        item_id: draft.item_id,
        application_id: draft.application_id,
        run_id: draft.run_id,
        suggested_decision: draft.suggested_decision,
        status,
        comment,
        revised_opinion: revisedOpinion,
        no_auto_decision:
          'Batch 20 draft handling does not call review.decide or mutate application status.',
      },
    });

    return updated;
  }

  async decide(
    actorId: string,
    traceId: string,
    itemId: string,
    input: ReviewDecisionRequest,
  ) {
    if (!itemId) {
      throw new ApiError('VALIDATION_ERROR', 'item_id is required');
    }

    assertDecision(input.decision);

    const comment = input.comment?.trim();
    if (input.decision === 'request_supplement' && !comment) {
      throw new ApiError(
        'VALIDATION_ERROR',
        'comment is required when requesting supplement',
      );
    }

    const task = await findReviewTaskByItemId(itemId);
    if (!task) {
      throw new ApiError('NOT_FOUND', 'review task not found');
    }

    if (!DECISION_ALLOWED_STATUSES.has(task.policy_item_status)) {
      throw new ApiError(
        'CONFLICT',
        `review task in ${task.policy_item_status} cannot be decided`,
      );
    }

    const itemCount = await countPolicyItemsByApplicationId(task.application_id);

    const target = DECISION_TARGET[input.decision];
    const decision = await applyReviewDecisionInTransaction({
      item_id: task.item_id,
      application_id: task.application_id,
      reviewer_id: actorId,
      action: input.decision,
      target_status: target.target_status,
      review_result: target.review_result,
      comment: comment || null,
    });

    await auditService.write({
      actor_id: actorId,
      action: `review.${input.decision}`,
      target_type: 'application_policy_item',
      target_id: task.item_id,
      trace_id: traceId,
      detail: {
        application_id: task.application_id,
        policy_id: task.policy_id,
        decision: input.decision,
        comment: comment ?? null,
        final_application_status: decision.application_status,
        final_policy_item_status: decision.policy_item_status,
        review_result: decision.review_result,
        policy_item_count: itemCount,
        aggregation_rule:
          'application.status is aggregated from all application_policy_items.',
      },
    });

    return {
      item_id: decision.item_id,
      application_id: decision.application_id,
      status: decision.policy_item_status,
      application_status: decision.application_status,
      review_result: decision.review_result,
      review_record_id: decision.record_id,
    };
  }

  async precheck(
    actorId: string,
    traceId: string,
    itemId: string,
    input: ReviewPrecheckRequest,
  ) {
    if (!itemId) {
      throw new ApiError('VALIDATION_ERROR', 'item_id is required');
    }
    const task = await findReviewTaskByItemId(itemId);
    if (!task) {
      throw new ApiError('NOT_FOUND', 'review task not found');
    }
    if (!DECISION_ALLOWED_STATUSES.has(task.policy_item_status)) {
      throw new ApiError(
        'CONFLICT',
        `review task in ${task.policy_item_status} cannot be prechecked`,
      );
    }

    const precheck = {
      eligibility_result: task.review_result ?? 'need_info',
      risk_items: [],
      missing_evidence: [],
      notice: '预审仅记录辅助结论，不替代最终人工审核决定。',
    };
    const result = await applyReviewPrecheckInTransaction({
      item_id: task.item_id,
      application_id: task.application_id,
      reviewer_id: actorId,
      comment: input.comment?.trim() || null,
      precheck,
    });

    await auditService.write({
      actor_id: actorId,
      action: 'review.precheck',
      target_type: 'application_policy_item',
      target_id: task.item_id,
      trace_id: traceId,
      detail: {
        idempotency_key: input.idempotency_key ?? null,
        application_id: task.application_id,
        policy_id: task.policy_id,
        application_status: result.application_status,
        policy_item_status: result.policy_item_status,
        precheck,
      },
    });

    return {
      item_id: result.item_id,
      application_id: result.application_id,
      status: result.policy_item_status,
      run_id: null,
      poll_url: null,
      precheck,
      review_record_id: result.record_id,
    };
  }

  async requestSupplement(
    actorId: string,
    traceId: string,
    itemId: string,
    input: SupplementRequest,
  ) {
    if (!itemId) {
      throw new ApiError('VALIDATION_ERROR', 'item_id is required');
    }
    if (!input || typeof input !== 'object') {
      throw new ApiError('VALIDATION_ERROR', 'request body is required');
    }
    const reason = input.reason?.trim();
    const requiredMaterials = input.required_materials ?? [];
    const fieldRequirements = input.field_requirements ?? [];
    if (!Array.isArray(requiredMaterials)) {
      throw new ApiError('VALIDATION_ERROR', 'required_materials must be an array');
    }
    if (!Array.isArray(fieldRequirements)) {
      throw new ApiError('VALIDATION_ERROR', 'field_requirements must be an array');
    }
    if (!reason) {
      throw new ApiError('VALIDATION_ERROR', 'reason is required');
    }
    if (requiredMaterials.length === 0 && fieldRequirements.length === 0) {
      throw new ApiError(
        'VALIDATION_ERROR',
        'required_materials or field_requirements are required',
      );
    }
    if (input.deadline_at) {
      const deadline = new Date(input.deadline_at);
      if (Number.isNaN(deadline.getTime())) {
        throw new ApiError('VALIDATION_ERROR', 'deadline_at must be ISO 8601 datetime');
      }
    }

    const task = await findReviewTaskByItemId(itemId);
    if (!task) {
      throw new ApiError('NOT_FOUND', 'review task not found');
    }
    if (!DECISION_ALLOWED_STATUSES.has(task.policy_item_status)) {
      throw new ApiError(
        'CONFLICT',
        `review task in ${task.policy_item_status} cannot request supplement`,
      );
    }

    const result = await applySupplementRequestInTransaction({
      item_id: task.item_id,
      application_id: task.application_id,
      reviewer_id: actorId,
      reason,
      deadline_at: input.deadline_at ?? null,
      required_materials: requiredMaterials,
      field_requirements: fieldRequirements,
    });

    await auditService.write({
      actor_id: actorId,
      action: 'review.supplement_request',
      target_type: 'application_policy_item',
      target_id: task.item_id,
      trace_id: traceId,
      detail: {
        idempotency_key: input.idempotency_key ?? null,
        application_id: task.application_id,
        policy_id: task.policy_id,
        reason,
        deadline_at: result.deadline_at,
        required_materials: requiredMaterials,
        field_requirements: fieldRequirements,
        application_status: result.application_status,
        policy_item_status: result.policy_item_status,
      },
    });

    return {
      item_id: result.item_id,
      application_id: result.application_id,
      application_status: result.application_status,
      policy_item_status: result.policy_item_status,
      review_record_id: result.record_id,
      deadline_at: result.deadline_at,
    };
  }
}

export const reviewService = new ReviewService();

function readDraftModelNames(agentOutputs: Record<string, unknown>): string[] {
  const models = new Set<string>();
  collectModels(agentOutputs, models);
  return [...models];
}

function collectModels(value: unknown, models: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectModels(item, models);
    }
    return;
  }
  if (!value || typeof value !== 'object') {
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (
      ['model', 'model_name'].includes(key) &&
      typeof child === 'string' &&
      child.trim() !== ''
    ) {
      models.add(child.trim());
    }
    collectModels(child, models);
  }
}
