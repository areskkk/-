import { ApiError } from '../../common/errors/http-error.js';
import { normalizePageQuery, pageResult, type PageQuery } from '../../common/pagination/pagination.js';
import { auditService } from '../audit/audit.service.js';
import {
  countPolicies,
  findPolicyById,
  insertPolicy,
  listPolicies,
  replacePolicySchema,
  updatePolicyStatus,
  type PolicyConditionInput,
  type PolicyMaterialRequirementInput,
} from './policies.repository.js';

export type PolicyImportRequest = {
  title: string;
  content?: string;
  text?: string;
  source_type: string;
  source_name?: string;
  source_url?: string;
  department_id?: string;
  version?: string;
  effective_date?: string;
  expire_date?: string;
  file_id?: string;
};

export type PolicySchemaRequest = {
  conditions?: PolicyConditionInput[];
  materials?: PolicyMaterialRequirementInput[];
};

export class PolicyService {
  async importPolicy(actorId: string, traceId: string, input: PolicyImportRequest) {
    if (!input.title || !input.source_type) {
      throw new ApiError('VALIDATION_ERROR', 'title and source_type are required');
    }

    const content = input.content ?? input.text ?? null;
    const policy = await insertPolicy({
      title: input.title,
      department_id: input.department_id ?? null,
      source_type: input.source_type,
      source_name: input.source_name ?? null,
      source_url: input.source_url ?? null,
      version: input.version ?? 'v1',
      effective_date: input.effective_date ?? null,
      expire_date: input.expire_date ?? null,
      content,
    });

    await auditService.write({
      actor_id: actorId,
      action: 'policy.import',
      target_type: 'policy',
      target_id: policy.policy_id,
      trace_id: traceId,
      detail: {
        import_mode: 'json_or_text_only',
        file_id_reference_only: input.file_id ?? null,
      },
    });

    return {
      ...policy,
      import_mode_notice:
        'Batch 2 supports JSON/text import only. file_id is treated as reference only and real file content is not processed.',
    };
  }

  async listPolicies(queryInput: PageQuery) {
    const normalized = normalizePageQuery(queryInput);
    const [items, total] = await Promise.all([
      listPolicies({
        limit: normalized.page_size,
        offset: (normalized.page - 1) * normalized.page_size,
        status: 'effective',
      }),
      countPolicies('effective'),
    ]);

    return pageResult(items, total, normalized);
  }

  async getPolicyDetail(policyId: string) {
    const policy = await findPolicyById(policyId, 'effective');
    if (!policy) {
      throw new ApiError('NOT_FOUND', 'policy not found');
    }

    return policy;
  }

  async updatePolicySchema(
    actorId: string,
    traceId: string,
    policyId: string,
    input: PolicySchemaRequest,
  ) {
    const policy = await findPolicyById(policyId);
    if (!policy) {
      throw new ApiError('NOT_FOUND', 'policy not found');
    }

    await replacePolicySchema({
      policy_id: policyId,
      conditions: input.conditions ?? [],
      materials: input.materials ?? [],
    });

    await auditService.write({
      actor_id: actorId,
      action: 'policy.schema.update',
      target_type: 'policy',
      target_id: policyId,
      trace_id: traceId,
      detail: {
        conditions_count: input.conditions?.length ?? 0,
        materials_count: input.materials?.length ?? 0,
      },
    });

    return {
      policy_id: policyId,
      schema_updated: true,
    };
  }

  async publishPolicy(actorId: string, traceId: string, policyId: string) {
    const policy = await findPolicyById(policyId);
    if (!policy) {
      throw new ApiError('NOT_FOUND', 'policy not found');
    }

    await updatePolicyStatus(policyId, 'effective');
    await auditService.write({
      actor_id: actorId,
      action: 'policy.publish',
      target_type: 'policy',
      target_id: policyId,
      trace_id: traceId,
      detail: {
        from_status: policy.status,
        to_status: 'effective',
      },
    });

    return {
      policy_id: policyId,
      status: 'effective',
    };
  }
}

export const policyService = new PolicyService();
