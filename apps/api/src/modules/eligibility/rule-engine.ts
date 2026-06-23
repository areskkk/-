export type EligibilityResult =
  | 'eligible'
  | 'ineligible'
  | 'need_info'
  | 'manual_review';

export type PolicyCondition = {
  condition_id: string;
  field_key: string;
  operator: string;
  target_value: unknown;
  required: boolean;
  evidence_type: string;
  fail_action: EligibilityResult;
  message: string | null;
};

export type EvidenceRef = {
  field_key: string;
  evidence_type: string;
  source: 'request' | 'profile' | 'ocr' | 'material';
  value: unknown;
  confidence?: number | null;
  application_id?: string | null;
  material_id?: string | null;
  ocr_result_id?: string | null;
  ocr_status?: string | null;
  overall_confidence?: number | null;
  requires_manual_confirmation?: boolean | null;
  warnings?: string[] | null;
};

export type RuleConditionResult = {
  condition_id: string;
  field_key: string;
  evidence_type: string;
  message: string | null;
  value?: unknown;
  target_value?: unknown;
  operator?: string;
  reason?: string;
  source?: EvidenceRef['source'];
  confidence?: number | null;
  material_id?: string | null;
  ocr_result_id?: string | null;
};

export type RuleEngineInput = {
  conditions: PolicyCondition[];
  evidence: Record<string, unknown>;
  evidenceRefs: EvidenceRef[];
};

export type RuleEngineOutput = {
  result: EligibilityResult;
  matched_conditions: RuleConditionResult[];
  failed_conditions: RuleConditionResult[];
  missing_fields: string[];
  citations: RuleConditionResult[];
  evidence_refs: EvidenceRef[];
};

const RESULT_PRIORITY: Record<EligibilityResult, number> = {
  eligible: 0,
  need_info: 1,
  manual_review: 2,
  ineligible: 3,
};

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

function resolveTargetValue(
  evidence: Record<string, unknown>,
  targetValue: unknown,
): unknown {
  if (
    typeof targetValue === 'string' &&
    targetValue.startsWith('$') &&
    targetValue.length > 1
  ) {
    return getByPath(evidence, targetValue.slice(1));
  }

  return targetValue;
}

function toComparableNumber(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function isMissing(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

function compareValue(operator: string, value: unknown, target: unknown): boolean {
  switch (operator) {
    case 'eq':
      return value === target;
    case 'neq':
      return value !== target;
    case 'in':
      return Array.isArray(target) && target.includes(value);
    case 'not_in':
      return Array.isArray(target) && !target.includes(value);
    case 'gte': {
      const left = toComparableNumber(value);
      const right = toComparableNumber(target);
      return left !== undefined && right !== undefined && left >= right;
    }
    case 'lte': {
      const left = toComparableNumber(value);
      const right = toComparableNumber(target);
      return left !== undefined && right !== undefined && left <= right;
    }
    case 'between': {
      const left = toComparableNumber(value);
      if (
        left === undefined ||
        target === null ||
        typeof target !== 'object' ||
        Array.isArray(target)
      ) {
        return false;
      }
      const min = toComparableNumber((target as Record<string, unknown>).min);
      const max = toComparableNumber((target as Record<string, unknown>).max);
      return (
        min !== undefined &&
        max !== undefined &&
        left >= min &&
        left <= max
      );
    }
    case 'exists':
      return Boolean(target) ? !isMissing(value) : isMissing(value);
    case 'contains':
      return typeof value === 'string' && typeof target === 'string'
        ? value.includes(target)
        : false;
    default:
      return false;
  }
}

function findEvidenceRef(
  evidenceRefs: EvidenceRef[],
  fieldKey: string,
): EvidenceRef | undefined {
  return evidenceRefs.find((ref) => ref.field_key === fieldKey);
}

export function evaluatePolicyConditions(
  input: RuleEngineInput,
): RuleEngineOutput {
  const matched: RuleConditionResult[] = [];
  const failed: RuleConditionResult[] = [];
  const missing = new Set<string>();
  const citations: RuleConditionResult[] = [];
  let result: EligibilityResult = 'eligible';

  for (const condition of input.conditions) {
    const value = getByPath(input.evidence, condition.field_key);
    const ref = findEvidenceRef(input.evidenceRefs, condition.field_key);
    const resolvedTargetValue = resolveTargetValue(input.evidence, condition.target_value);
    const base: RuleConditionResult = {
      condition_id: condition.condition_id,
      field_key: condition.field_key,
      evidence_type: condition.evidence_type,
      message: condition.message,
      value,
      target_value: resolvedTargetValue,
      operator: condition.operator,
      source: ref?.source,
      confidence: ref?.confidence ?? null,
      material_id: ref?.material_id ?? null,
      ocr_result_id: ref?.ocr_result_id ?? null,
    };

    if (isMissing(value)) {
      missing.add(condition.field_key);
      failed.push({ ...base, reason: 'missing_field' });
      if (RESULT_PRIORITY.need_info > RESULT_PRIORITY[result]) {
        result = 'need_info';
      }
      continue;
    }

    if (
      ref?.confidence !== undefined &&
      ref.confidence !== null &&
      ref.confidence < 0.85
    ) {
      failed.push({ ...base, reason: 'low_confidence_evidence' });
      const lowConfidenceResult = condition.fail_action === 'need_info'
        ? 'need_info'
        : 'manual_review';
      if (RESULT_PRIORITY[lowConfidenceResult] > RESULT_PRIORITY[result]) {
        result = lowConfidenceResult;
      }
      continue;
    }

    if (compareValue(condition.operator, value, resolvedTargetValue)) {
      matched.push(base);
      citations.push(base);
      continue;
    }

    failed.push({ ...base, reason: 'condition_not_met' });
    if (RESULT_PRIORITY[condition.fail_action] > RESULT_PRIORITY[result]) {
      result = condition.fail_action;
    }
  }

  return {
    result,
    matched_conditions: matched,
    failed_conditions: failed,
    missing_fields: [...missing],
    citations,
    evidence_refs: input.evidenceRefs,
  };
}
