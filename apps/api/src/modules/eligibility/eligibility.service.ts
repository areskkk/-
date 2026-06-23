import { ApiError } from '../../common/errors/http-error.js';
import { auditService } from '../audit/audit.service.js';
import { getCurrentProfileByEnterpriseId } from '../enterprise-profile/enterprise-profile.repository.js';
import { findApprovedEnterprisesByUserId } from '../enterprises/enterprises.repository.js';
import {
  evaluatePolicyConditions,
  type EvidenceRef,
  type PolicyCondition,
  type RuleConditionResult,
} from './rule-engine.js';
import {
  findApplicationPolicyEvidence,
  findApplicationPolicyItemIdByPolicyId,
  findWhitelistedEffectivePolicy,
  listMaterialEvidenceByApplicationId,
  listPolicyConditions,
} from './eligibility.repository.js';
import {
  createEligibilitySourceId,
  fallbackService,
} from '../fallback/fallback.service.js';

export type EligibilityCheckRequest = {
  enterprise_id: string;
  policy_id?: string;
  application_id?: string;
  item_id?: string;
  profile_snapshot?: Record<string, unknown>;
  evidence?: Record<string, unknown>;
  policy_ids?: string[];
  confirmed_materials?: string[];
};

export type EligibilitySingleResult = {
  policy_id: string;
  result: string;
  matched_conditions: RuleConditionResult[];
  failed_conditions: RuleConditionResult[];
  missing_fields: string[];
  citations: RuleConditionResult[];
  evidence_refs: Array<EvidenceRef & { summary: string }>;
  fallback_task: { task_id: string; created: boolean } | null;
  ai_summary: string;
  evidence_priority_notice: string;
  rule_first_notice: string;
};

export type EligibilityBatchResult = {
  enterprise_id: string;
  results: EligibilitySingleResult[];
};

const OCR_CONFIDENCE_THRESHOLD = 0.85;

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

function setByPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let current = target;
  for (const part of parts.slice(0, -1)) {
    const next = current[part];
    if (next === null || typeof next !== 'object' || Array.isArray(next)) {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]] = value;
}

function getByPath(source: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = source;
  for (const part of parts) {
    if (
      current === null ||
      typeof current !== 'object' ||
      Array.isArray(current) ||
      !(part in current)
    ) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function mergeIfMissing(
  target: Record<string, unknown>,
  path: string,
  value: unknown,
  refs: EvidenceRef[],
  ref: EvidenceRef,
): void {
  if (value === undefined || value === null || value === '') {
    return;
  }
  if (getByPath(target, path) !== undefined) {
    return;
  }
  setByPath(target, path, value);
  refs.push(ref);
}

function profileToEvidence(profile: {
  enterprise_name: string;
  credit_code: string;
  industry: string | null;
  scale: string | null;
  revenue_amount: string | null;
  employee_count: number | null;
  tax_amount: string | null;
  export_amount: string | null;
  tech_upgrade_status: string | null;
  profile_json: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    enterprise_profile: {
      enterprise_name: profile.enterprise_name,
      credit_code: profile.credit_code,
      industry: profile.industry,
      scale: profile.scale,
      revenue_amount: profile.revenue_amount === null ? null : Number(profile.revenue_amount),
      employee_count: profile.employee_count,
      tax_amount: profile.tax_amount === null ? null : Number(profile.tax_amount),
      export_amount: profile.export_amount === null ? null : Number(profile.export_amount),
      tech_upgrade_status: profile.tech_upgrade_status,
      ...profile.profile_json,
    },
  };
}

function explicitEvidence(input: EligibilityCheckRequest): Record<string, unknown> {
  const base = { ...(input.evidence ?? {}) };
  if (!input.profile_snapshot) {
    return base;
  }

  return {
    ...base,
    enterprise_profile: {
      ...((base.enterprise_profile as Record<string, unknown> | undefined) ?? {}),
      ...input.profile_snapshot,
    },
  };
}

function collectLeafEvidenceRefs(
  value: unknown,
  prefix: string,
  refs: EvidenceRef[],
): void {
  if (value === undefined || value === null || value === '') {
    return;
  }

  if (Array.isArray(value) || typeof value !== 'object') {
    refs.push({
      field_key: prefix,
      evidence_type: prefix.startsWith('ocr.')
        ? 'ocr'
        : prefix.startsWith('materials.')
          ? 'material'
          : 'profile',
      source: 'request',
      value,
    });
    return;
  }

  for (const [key, nested] of Object.entries(value)) {
    collectLeafEvidenceRefs(nested, `${prefix}.${key}`, refs);
  }
}

function numberOrNull(value: string | null): number | null {
  if (value === null) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function summarizeEvidenceRef(ref: EvidenceRef): string {
  if (ref.source === 'request') {
    return `请求体显式输入：${ref.field_key}`;
  }
  if (ref.source === 'profile') {
    return `当前企业画像：${ref.field_key}`;
  }
  if (ref.source === 'material') {
    return `当前材料：${ref.field_key}`;
  }
  const confidenceText = ref.confidence === undefined || ref.confidence === null
    ? ''
    : `，置信度 ${ref.confidence.toFixed(2)}`;
  return `OCR 识别：${ref.field_key}${confidenceText}`;
}

function describeCondition(result: {
  field_key: string;
  message: string | null;
  reason?: string;
  source?: EvidenceRef['source'];
  confidence?: number | null;
}): string {
  if (result.message) {
    return result.message;
  }
  if (result.reason === 'low_confidence_evidence') {
    const confidenceText = result.confidence === null || result.confidence === undefined
      ? ''
      : `（置信度 ${result.confidence.toFixed(2)}）`;
    return `${result.field_key} 的 OCR 证据置信度不足${confidenceText}`;
  }
  if (result.reason === 'missing_field') {
    return `${result.field_key} 缺少可用证据`;
  }
  if (result.reason === 'condition_not_met') {
    return `${result.field_key} 未满足政策条件`;
  }
  return result.field_key;
}

function explainEligibility(input: {
  result: string;
  missing_fields: string[];
  matched_conditions: Array<{
    field_key: string;
    message: string | null;
    source?: EvidenceRef['source'];
  }>;
  failed_conditions: Array<{
    field_key: string;
    message: string | null;
    reason?: string;
    source?: EvidenceRef['source'];
    confidence?: number | null;
  }>;
}): string {
  if (input.result === 'eligible') {
    const supports = input.matched_conditions
      .slice(0, 3)
      .map((item) => item.message ?? item.field_key);
    return supports.length > 0
      ? `已满足主要资格条件：${supports.join('；')}。`
      : '已满足已发布规则中的主要资格条件，可继续准备申报材料。';
  }

  if (input.result === 'ineligible') {
    const reasons = input.failed_conditions
      .filter((item) => item.reason === 'condition_not_met')
      .slice(0, 3)
      .map(describeCondition);
    return reasons.length > 0
      ? `当前不符合申报条件：${reasons.join('；')}。`
      : '存在硬性条件未满足，当前不建议按该政策提交申报。';
  }

  if (input.result === 'manual_review') {
    const reasons = input.failed_conditions
      .filter((item) => item.reason === 'low_confidence_evidence')
      .slice(0, 3)
      .map(describeCondition);
    if (reasons.length > 0) {
      return `当前证据需要人工确认：${reasons.join('；')}。`;
    }
    return '存在低置信度、证据冲突或需人工判断的条件，请进行人工确认。';
  }

  if (input.missing_fields.length > 0) {
    return `还需补充以下证据后才能继续判断：${input.missing_fields.join('、')}。`;
  }

  const lowConfidenceReasons = input.failed_conditions
    .filter((item) => item.reason === 'low_confidence_evidence')
    .slice(0, 3)
    .map(describeCondition);
  if (lowConfidenceReasons.length > 0) {
    return `已有证据置信度不足，建议补充更清晰材料或人工确认：${lowConfidenceReasons.join('；')}。`;
  }

  return '还需补充关键画像或材料证据。';
}

export class EligibilityService {
  async check(
    actorId: string,
    traceId: string,
    input: EligibilityCheckRequest,
  ): Promise<EligibilitySingleResult | EligibilityBatchResult> {
    const policyIds = normalizePolicyIds(input);
    if (policyIds.length > 1) {
      const results: EligibilitySingleResult[] = [];
      for (const policyId of policyIds) {
        const itemId = input.application_id
          ? await findApplicationPolicyItemIdByPolicyId({
              application_id: input.application_id,
              policy_id: policyId,
            })
          : undefined;
        results.push(await this.checkSingle(actorId, traceId, {
          ...input,
          policy_id: policyId,
          policy_ids: undefined,
          item_id: itemId ?? input.item_id,
        }));
      }
      return {
        enterprise_id: input.enterprise_id,
        results,
      };
    }
    return this.checkSingle(actorId, traceId, {
      ...input,
      policy_id: policyIds[0],
      policy_ids: undefined,
    });
  }

  private async checkSingle(
    actorId: string,
    traceId: string,
    input: EligibilityCheckRequest & { policy_id?: string },
  ): Promise<EligibilitySingleResult> {
    if (!input.enterprise_id || !input.policy_id) {
      throw new ApiError('VALIDATION_ERROR', 'enterprise_id and policy_id are required');
    }

    await assertEnterpriseMembership(actorId, input.enterprise_id);

    const policy = await findWhitelistedEffectivePolicy(input.policy_id);
    if (!policy) {
      throw new ApiError('NOT_FOUND', 'policy not found or not enabled for Batch 7 AI');
    }

    if (input.application_id) {
      const application = await findApplicationPolicyEvidence(
        input.application_id,
        input.item_id,
      );
      if (!application) {
        throw new ApiError('NOT_FOUND', 'application not found');
      }
      if (application.enterprise_id !== input.enterprise_id) {
        throw new ApiError('FORBIDDEN', 'application enterprise mismatch');
      }
      if (!input.item_id && Number(application.policy_item_count) !== 1) {
        throw new ApiError('CONFLICT', 'Batch 7 supports single-policy application only');
      }
      if (application.policy_id !== input.policy_id) {
        throw new ApiError('CONFLICT', 'application policy does not match request policy_id');
      }
    }

    const conditions = await listPolicyConditions(input.policy_id);
    if (conditions.length === 0) {
      throw new ApiError('CONFLICT', 'policy has no reviewed rules');
    }

    const evidence = explicitEvidence(input);
    const evidenceRefs: EvidenceRef[] = [];

    for (const [key, value] of Object.entries(input.evidence ?? {})) {
      collectLeafEvidenceRefs(value, key, evidenceRefs);
    }

    for (const [key, value] of Object.entries(input.profile_snapshot ?? {})) {
      evidenceRefs.push({
        field_key: `enterprise_profile.${key}`,
        evidence_type: 'profile',
        source: 'request',
        value,
      });
    }

    const currentProfile = await getCurrentProfileByEnterpriseId(input.enterprise_id);
    if (currentProfile) {
      const profileEvidence = profileToEvidence(currentProfile);
      for (const [key, value] of Object.entries(
        profileEvidence.enterprise_profile as Record<string, unknown>,
      )) {
        mergeIfMissing(evidence, `enterprise_profile.${key}`, value, evidenceRefs, {
          field_key: `enterprise_profile.${key}`,
          evidence_type: 'profile',
          source: 'profile',
          value,
        });
      }
    }

    if (input.application_id) {
      const confirmedMaterials = new Set(
        Array.isArray(input.confirmed_materials)
          ? input.confirmed_materials.filter((item): item is string => typeof item === 'string')
          : [],
      );
      const materials = await listMaterialEvidenceByApplicationId({
        applicationId: input.application_id,
        itemId: input.item_id,
      });
      for (const material of materials) {
        mergeIfMissing(
          evidence,
          `materials.${material.material_type}.file_id`,
          material.file_id,
          evidenceRefs,
          {
            field_key: `materials.${material.material_type}.file_id`,
            evidence_type: 'material',
            source: 'material',
            value: material.file_id,
            application_id: material.application_id,
            material_id: material.material_id,
          },
        );

        mergeIfMissing(
          evidence,
          `materials.${material.material_type}.issue_date`,
          material.issue_date,
          evidenceRefs,
          {
            field_key: `materials.${material.material_type}.issue_date`,
            evidence_type: 'material',
            source: 'material',
            value: material.issue_date,
            application_id: material.application_id,
            material_id: material.material_id,
          },
        );

        mergeIfMissing(
          evidence,
          `materials.${material.material_type}.expire_date`,
          material.expire_date,
          evidenceRefs,
          {
            field_key: `materials.${material.material_type}.expire_date`,
            evidence_type: 'material',
            source: 'material',
            value: material.expire_date,
            application_id: material.application_id,
            material_id: material.material_id,
          },
        );

        for (const [field, value] of Object.entries(material.ocr_fields ?? {})) {
          const confidence = material.field_confidence?.[field] ?? null;
          const manuallyConfirmed = confirmedMaterials.has(material.material_id);
          mergeIfMissing(
            evidence,
            `ocr.${material.material_type}.${field}`,
            value,
            evidenceRefs,
            {
              field_key: `ocr.${material.material_type}.${field}`,
              evidence_type: 'ocr',
              source: 'ocr',
              value,
              confidence: !manuallyConfirmed && material.requires_manual_confirmation
                ? Math.min(confidence ?? 0, OCR_CONFIDENCE_THRESHOLD - 0.01)
                : confidence,
              application_id: material.application_id,
              material_id: material.material_id,
              ocr_result_id: material.ocr_result_id,
              ocr_status: material.ocr_status,
              overall_confidence: numberOrNull(material.overall_confidence),
              requires_manual_confirmation: manuallyConfirmed
                ? false
                : material.requires_manual_confirmation,
              warnings: material.warnings,
            },
          );
        }
      }
    }

    const ruleResult = evaluatePolicyConditions({
      conditions: conditions as PolicyCondition[],
      evidence,
      evidenceRefs,
    });

    const summary = explainEligibility({
      result: ruleResult.result,
      missing_fields: ruleResult.missing_fields,
      matched_conditions: ruleResult.matched_conditions,
      failed_conditions: ruleResult.failed_conditions,
    });

    await auditService.write({
      actor_id: actorId,
      action: 'eligibility.check',
      target_type: 'policy',
      target_id: input.policy_id,
      trace_id: traceId,
      detail: {
        enterprise_id: input.enterprise_id,
        application_id: input.application_id ?? null,
        item_id: input.item_id ?? null,
        result: ruleResult.result,
        rule_first: true,
        evidence_ref_count: ruleResult.evidence_refs.length,
        matched_condition_count: ruleResult.matched_conditions.length,
        failed_condition_count: ruleResult.failed_conditions.length,
      },
    });

    let fallbackTask: { task_id: string; created: boolean } | null = null;
    if (ruleResult.result === 'manual_review') {
      const fallback = await fallbackService.createIfNotExists({
        actor_id: actorId,
        trace_id: traceId,
        source_type: 'eligibility',
        source_id: createEligibilitySourceId({
          enterprise_id: input.enterprise_id,
          policy_id: input.policy_id,
          application_id: input.application_id,
          item_id: input.item_id,
        }),
        reason: 'eligibility_manual_review',
        context: {
          enterprise_id: input.enterprise_id,
          policy_id: input.policy_id,
          application_id: input.application_id ?? null,
          item_id: input.item_id ?? null,
          failed_conditions: ruleResult.failed_conditions,
          missing_fields: ruleResult.missing_fields,
          citation_count: ruleResult.citations.length,
          low_confidence_fields: ruleResult.failed_conditions
            .filter((item) => item.reason === 'low_confidence_evidence')
            .map((item) => item.field_key),
        },
      });
      fallbackTask = {
        task_id: fallback.task.task_id,
        created: fallback.created,
      };
    }

    return {
      policy_id: input.policy_id,
      result: ruleResult.result,
      matched_conditions: ruleResult.matched_conditions,
      failed_conditions: ruleResult.failed_conditions,
      missing_fields: ruleResult.missing_fields,
      citations: ruleResult.citations,
      evidence_refs: ruleResult.evidence_refs.map((ref) => ({
        ...ref,
        summary: summarizeEvidenceRef(ref),
      })),
      fallback_task: fallbackTask,
      ai_summary: summary,
      evidence_priority_notice:
        '证据优先级：请求体显式输入 > 当前企业画像 > 当前 application 的有效材料/OCR 结果。',
      rule_first_notice:
        '资格预判以已审核 DSL 规则为准；AI 仅生成解释文案，不替代规则裁决。',
    };
  }
}

export const eligibilityService = new EligibilityService();

function normalizePolicyIds(input: EligibilityCheckRequest): string[] {
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
