import { ApiError } from '../../common/errors/http-error.js';
import {
  normalizePageQuery,
  pageResult,
  type PageQuery,
} from '../../common/pagination/pagination.js';
import { auditService } from '../audit/audit.service.js';
import { findApprovedEnterprisesByUserId } from '../enterprises/enterprises.repository.js';
import { getCurrentProfileByEnterpriseId } from '../enterprise-profile/enterprise-profile.repository.js';
import { findPolicyById } from '../policies/policies.repository.js';
import { listMaterialsByApplicationId } from '../materials/materials.repository.js';
import { findFileById } from '../files/files.repository.js';
import { buildEnterpriseOcrSummary } from '../ocr/ocr-summary.js';
import {
  countApplicationsByEnterpriseId,
  findApplicationDetailById,
  listLatestSupplementRequestsByApplicationId,
  insertApplication,
  insertApplicationPolicyItems,
  listApplicationsByEnterpriseId,
  submitSupplementInTransaction,
  submitApplicationInTransaction,
  withdrawApplicationInTransaction,
  type SupplementMaterialInput,
  type LatestSupplementRequestRow,
} from './applications.repository.js';

export type CreateApplicationRequest = {
  enterprise_id: string;
  policy_id?: string;
  policy_ids?: string[];
};

export type WithdrawApplicationRequest = {
  idempotency_key?: string;
  comment?: string;
};

export type SupplementMaterialRequest = {
  material_type: string;
  file_id: string;
  mode: 'append' | 'replace';
  issue_date?: string;
  expire_date?: string;
  security_level?: string;
};

export type SubmitSupplementRequest = {
  item_id?: string;
  materials: SupplementMaterialRequest[];
  comment?: string;
};

const ALLOWED_SUPPLEMENT_MODES = new Set(['append', 'replace']);
const ALLOWED_SECURITY_LEVELS = new Set(['L1', 'L2', 'L3', 'L4']);
const WITHDRAWABLE_STATUSES = new Set([
  'submitted',
  'pre_reviewing',
  'reviewing',
  'need_supplement',
  'resubmitted',
  'manual_review',
]);

async function assertEnterpriseMembership(
  actorId: string,
  enterpriseId: string,
): Promise<void> {
  const enterprises = await findApprovedEnterprisesByUserId(actorId);
  const matched = enterprises.find((enterprise) => enterprise.enterprise_id === enterpriseId);
  if (!matched) {
    throw new ApiError('FORBIDDEN', 'enterprise access is denied');
  }
}

export class ApplicationService {
  async createDraft(
    actorId: string,
    traceId: string,
    input: CreateApplicationRequest,
  ) {
    const policyIds = normalizePolicyIds(input);
    if (!input.enterprise_id || policyIds.length === 0) {
      throw new ApiError('VALIDATION_ERROR', 'enterprise_id and policy_id or policy_ids are required');
    }

    await assertEnterpriseMembership(actorId, input.enterprise_id);
    for (const policyId of policyIds) {
      const policy = await findPolicyById(policyId, 'effective');
      if (!policy) {
        throw new ApiError('NOT_FOUND', `effective policy not found: ${policyId}`);
      }
    }

    const application = await insertApplication({
      enterprise_id: input.enterprise_id,
      applicant_user_id: actorId,
      status: 'draft',
    });
    const policyItems = await insertApplicationPolicyItems({
      application_id: application.application_id,
      policy_ids: policyIds,
      status: 'draft',
    });

    await auditService.write({
      actor_id: actorId,
      action: 'application.create',
      target_type: 'application',
      target_id: application.application_id,
      trace_id: traceId,
      detail: {
        enterprise_id: input.enterprise_id,
        policy_ids: policyIds,
        mode: policyIds.length === 1 ? 'single_policy' : 'multi_policy',
      },
    });

    return {
      ...application,
      policy_item: policyItems[0],
      policy_items: policyItems,
    };
  }

  async listByEnterprise(
    actorId: string,
    enterpriseId: string,
    queryInput: PageQuery,
  ) {
    await assertEnterpriseMembership(actorId, enterpriseId);
    const normalized = normalizePageQuery(queryInput);
    const [items, total] = await Promise.all([
      listApplicationsByEnterpriseId({
        enterprise_id: enterpriseId,
        limit: normalized.page_size,
        offset: (normalized.page - 1) * normalized.page_size,
      }),
      countApplicationsByEnterpriseId(enterpriseId),
    ]);

    return pageResult(items, total, normalized);
  }

  async getDetail(actorId: string, applicationId: string) {
    const rows = await findApplicationDetailById(applicationId);
    if (rows.length === 0) {
      throw new ApiError('NOT_FOUND', 'application not found');
    }

    const application = rows[0];
    await assertEnterpriseMembership(actorId, application.enterprise_id);
    const [materials, latestSupplementRequests] = await Promise.all([
      listMaterialsByApplicationId(application.application_id),
      listLatestSupplementRequestsByApplicationId(application.application_id),
    ]);

    return {
      application_id: application.application_id,
      enterprise_id: application.enterprise_id,
      applicant_user_id: application.applicant_user_id,
      profile_snapshot_id: application.profile_snapshot_id,
      status: application.status,
      submit_time: application.submit_time,
      deadline_at: application.deadline_at,
      created_at: application.created_at,
      policy_items: rows.map((row) => ({
        item_id: row.policy_item_id,
        policy_id: row.policy_id,
        status: row.policy_item_status,
        review_result: row.policy_item_review_result,
      })),
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
        ocr_summary: buildEnterpriseOcrSummary({
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
        is_current: material.is_current,
        replaced_by_material_id: material.replaced_by_material_id,
        superseded_at: material.superseded_at,
        created_at: material.created_at,
      })),
      supplements: latestSupplementRequests.map(formatSupplementRequest),
      supplement: latestSupplementRequests.length === 1
        ? formatSupplementRequest(latestSupplementRequests[0])
        : null,
    };
  }

  async submit(actorId: string, traceId: string, applicationId: string) {
    const rows = await findApplicationDetailById(applicationId);
    if (rows.length === 0) {
      throw new ApiError('NOT_FOUND', 'application not found');
    }

    const application = rows[0];
    await assertEnterpriseMembership(actorId, application.enterprise_id);

    if (application.status !== 'draft') {
      throw new ApiError('CONFLICT', 'only draft applications can be submitted');
    }

    for (const row of rows) {
      const policy = await findPolicyById(row.policy_id, 'effective');
      if (!policy) {
        throw new ApiError('CONFLICT', `bound policy is not effective: ${row.policy_id}`);
      }
    }

    const currentProfile = await getCurrentProfileByEnterpriseId(application.enterprise_id);
    if (!currentProfile) {
      throw new ApiError('CONFLICT', 'current enterprise profile is required before submit');
    }

    if (!currentProfile.industry) {
      throw new ApiError('CONFLICT', 'current enterprise profile industry is required before submit');
    }

    const submitResult = await submitApplicationInTransaction({
      application_id: application.application_id,
      policy_item_ids: rows.map((row) => row.policy_item_id),
      profile_snapshot: {
        enterprise_id: currentProfile.enterprise_id,
        industry: currentProfile.industry,
        scale: currentProfile.scale,
        revenue_amount: currentProfile.revenue_amount
          ? Number(currentProfile.revenue_amount)
          : null,
        employee_count: currentProfile.employee_count,
        tax_amount: currentProfile.tax_amount ? Number(currentProfile.tax_amount) : null,
        export_amount: currentProfile.export_amount
          ? Number(currentProfile.export_amount)
          : null,
        tech_upgrade_status: currentProfile.tech_upgrade_status,
        source: currentProfile.source,
        profile_json: currentProfile.profile_json,
      },
    });

    await auditService.write({
      actor_id: actorId,
      action: 'application.submit',
      target_type: 'application',
      target_id: applicationId,
      trace_id: traceId,
      detail: {
        snapshot_id: submitResult.snapshot_id,
        policy_ids: rows.map((row) => row.policy_id),
        policy_item_ids: rows.map((row) => row.policy_item_id),
        transaction_mode: rows.length === 1 ? 'single_policy_submit' : 'multi_policy_submit',
      },
    });

    return {
      application_id: applicationId,
      status: 'submitted',
      profile_snapshot_id: submitResult.snapshot_id,
    };
  }

  async withdraw(
    actorId: string,
    traceId: string,
    applicationId: string,
    input: WithdrawApplicationRequest,
  ) {
    const rows = await findApplicationDetailById(applicationId);
    if (rows.length === 0) {
      throw new ApiError('NOT_FOUND', 'application not found');
    }

    const application = rows[0];
    await assertEnterpriseMembership(actorId, application.enterprise_id);

    if (!WITHDRAWABLE_STATUSES.has(application.status)) {
      throw new ApiError(
        'CONFLICT',
        `application in ${application.status} cannot be withdrawn`,
      );
    }

    const comment = input.comment?.trim() || null;
    const withdrawn = await withdrawApplicationInTransaction({
      application_id: application.application_id,
      comment,
    });

    await auditService.write({
      actor_id: actorId,
      action: 'application.withdraw',
      target_type: 'application',
      target_id: applicationId,
      trace_id: traceId,
      detail: {
        idempotency_key: input.idempotency_key ?? null,
        from_status: application.status,
        to_status: withdrawn.status,
        policy_item_ids: rows.map((row) => row.policy_item_id),
        comment,
      },
    });

    return {
      application_id: withdrawn.application_id,
      status: withdrawn.status,
      withdrawn_at: withdrawn.withdrawn_at,
    };
  }

  async submitSupplement(
    actorId: string,
    traceId: string,
    applicationId: string,
    input: SubmitSupplementRequest,
  ) {
    const rows = await findApplicationDetailById(applicationId);
    if (rows.length === 0) {
      throw new ApiError('NOT_FOUND', 'application not found');
    }

    const application = rows[0];
    await assertEnterpriseMembership(actorId, application.enterprise_id);

    if (application.status !== 'need_supplement') {
      throw new ApiError(
        'CONFLICT',
        'only need_supplement applications can submit supplements',
      );
    }

    const targetItem = input.item_id
      ? rows.find((row) => row.policy_item_id === input.item_id)
      : rows.length === 1
        ? rows[0]
        : undefined;
    if (!targetItem) {
      throw new ApiError(
        'VALIDATION_ERROR',
        'item_id is required for multi-policy supplement submit',
      );
    }
    if (targetItem.policy_item_status !== 'need_supplement') {
      throw new ApiError('CONFLICT', 'target policy item is not need_supplement');
    }

    if (!Array.isArray(input.materials) || input.materials.length === 0) {
      throw new ApiError('VALIDATION_ERROR', 'materials are required');
    }

    const supplementMaterials: SupplementMaterialInput[] = [];
    for (const material of input.materials) {
      if (!material.material_type || !material.file_id || !material.mode) {
        throw new ApiError(
          'VALIDATION_ERROR',
          'material_type, file_id and mode are required for each material',
        );
      }

      if (!ALLOWED_SUPPLEMENT_MODES.has(material.mode)) {
        throw new ApiError('VALIDATION_ERROR', 'material mode must be append or replace');
      }

      if (
        material.security_level &&
        !ALLOWED_SECURITY_LEVELS.has(material.security_level)
      ) {
        throw new ApiError('VALIDATION_ERROR', 'invalid security_level');
      }

      const file = await findFileById(material.file_id);
      if (!file) {
        throw new ApiError('NOT_FOUND', 'file not found');
      }

      if (file.enterprise_id !== application.enterprise_id) {
        throw new ApiError('FORBIDDEN', 'file does not belong to application enterprise');
      }
      if (file.purpose !== 'enterprise_resource') {
        throw new ApiError(
          'VALIDATION_ERROR',
          'supplement materials must use enterprise_resource files',
        );
      }

      supplementMaterials.push({
        material_type: material.material_type,
        file_id: material.file_id,
        file_hash: file.file_hash,
        mode: material.mode,
        issue_date: material.issue_date,
        expire_date: material.expire_date,
        security_level: material.security_level,
      });
    }

    try {
      const result = await submitSupplementInTransaction({
        application_id: application.application_id,
        policy_item_id: targetItem.policy_item_id,
        materials: supplementMaterials,
      });

      await auditService.write({
        actor_id: actorId,
        action: 'application.supplement.submit',
        target_type: 'application',
        target_id: applicationId,
        trace_id: traceId,
        detail: {
          from_status: 'need_supplement',
          to_status: result.application_status,
          policy_item_id: targetItem.policy_item_id,
          policy_item_status: result.policy_item_status,
          policy_item_review_result: result.policy_item_review_result,
          comment: input.comment ?? null,
          material_operations: result.materials,
          aggregation_rule:
            'application.status is aggregated from all application_policy_items.',
        },
      });

      return {
        application_id: application.application_id,
        status: result.application_status,
        policy_item: {
          item_id: targetItem.policy_item_id,
          status: result.policy_item_status,
          review_result: result.policy_item_review_result,
        },
        materials: result.materials,
      };
    } catch (error) {
      if (error instanceof Error) {
        if (error.message.startsWith('current material already exists')) {
          throw new ApiError('CONFLICT', error.message);
        }
        if (error.message.startsWith('current material does not exist')) {
          throw new ApiError('CONFLICT', error.message);
        }
        if (error.message.startsWith('replace requires exactly one current material')) {
          throw new ApiError('CONFLICT', error.message);
        }
      }

      throw error;
    }
  }
}

export const applicationService = new ApplicationService();

function normalizePolicyIds(input: CreateApplicationRequest): string[] {
  const ids = input.policy_ids ?? (input.policy_id ? [input.policy_id] : []);
  if (!Array.isArray(ids)) {
    throw new ApiError('VALIDATION_ERROR', 'policy_ids must be an array');
  }
  const normalized = ids
    .filter((id): id is string => typeof id === 'string')
    .map((id) => id.trim())
    .filter((id) => id !== '');
  return [...new Set(normalized)];
}

function formatSupplementRequest(row: LatestSupplementRequestRow) {
  let parsed: {
    reason?: unknown;
    required_materials?: unknown;
    field_requirements?: unknown;
    deadline_at?: unknown;
  } = {};
  if (row.comment) {
    try {
      parsed = JSON.parse(row.comment);
    } catch {
      parsed = { reason: row.comment };
    }
  }
  const deadlineAt = typeof parsed.deadline_at === 'string' ? parsed.deadline_at : null;
  return {
    review_record_id: row.record_id,
    item_id: row.item_id,
    reason: typeof parsed.reason === 'string' ? parsed.reason : row.comment,
    required_materials: Array.isArray(parsed.required_materials)
      ? parsed.required_materials
      : [],
    field_requirements: Array.isArray(parsed.field_requirements)
      ? parsed.field_requirements
      : [],
    deadline_at: deadlineAt,
    requested_at: row.created_at,
  };
}
