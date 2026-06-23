import { describe, expect, it } from 'vitest';
import { evaluatePolicyConditions, type PolicyCondition } from '../src/modules/eligibility/rule-engine.js';
import { normalizeQuestion } from '../src/modules/fallback/fallback.service.js';

function condition(input: Partial<PolicyCondition> & Pick<PolicyCondition, 'field_key' | 'operator' | 'target_value'>): PolicyCondition {
  return {
    condition_id: input.condition_id ?? input.field_key,
    field_key: input.field_key,
    operator: input.operator,
    target_value: input.target_value,
    required: input.required ?? true,
    evidence_type: input.evidence_type ?? 'profile',
    fail_action: input.fail_action ?? 'ineligible',
    message: input.message ?? null,
  };
}

describe('rule engine', () => {
  it('matches supported DSL operators', () => {
    const result = evaluatePolicyConditions({
      conditions: [
        condition({ field_key: 'enterprise_profile.industry', operator: 'in', target_value: ['家具制造'] }),
        condition({ field_key: 'enterprise_profile.revenue_amount', operator: 'gte', target_value: 5000000 }),
        condition({ field_key: 'enterprise_profile.employee_count', operator: 'between', target_value: { min: 10, max: 100 } }),
        condition({ field_key: 'materials.business_license.file_id', operator: 'exists', target_value: true, evidence_type: 'material' }),
        condition({ field_key: 'enterprise_profile.tech_upgrade_status', operator: 'contains', target_value: 'completed' }),
      ],
      evidence: {
        enterprise_profile: {
          industry: '家具制造',
          revenue_amount: 6000000,
          employee_count: 20,
          tech_upgrade_status: 'completed_2026',
        },
        materials: {
          business_license: {
            file_id: 'file-1',
          },
        },
      },
      evidenceRefs: [],
    });

    expect(result.result).toBe('eligible');
    expect(result.matched_conditions).toHaveLength(5);
    expect(result.failed_conditions).toHaveLength(0);
  });

  it('returns need_info for missing fields', () => {
    const result = evaluatePolicyConditions({
      conditions: [
        condition({
          field_key: 'enterprise_profile.tax_amount',
          operator: 'gte',
          target_value: 100000,
          fail_action: 'need_info',
        }),
      ],
      evidence: { enterprise_profile: {} },
      evidenceRefs: [],
    });

    expect(result.result).toBe('need_info');
    expect(result.missing_fields).toEqual(['enterprise_profile.tax_amount']);
  });

  it('returns ineligible for hard condition failure', () => {
    const result = evaluatePolicyConditions({
      conditions: [
        condition({
          field_key: 'enterprise_profile.industry',
          operator: 'in',
          target_value: ['家具制造'],
          fail_action: 'ineligible',
        }),
      ],
      evidence: { enterprise_profile: { industry: '餐饮' } },
      evidenceRefs: [],
    });

    expect(result.result).toBe('ineligible');
    expect(result.failed_conditions[0].reason).toBe('condition_not_met');
  });

  it('returns manual_review for low-confidence OCR evidence', () => {
    const result = evaluatePolicyConditions({
      conditions: [
        condition({
          field_key: 'ocr.business_license.credit_code',
          operator: 'eq',
          target_value: '913607FF0000000701',
          evidence_type: 'ocr',
          fail_action: 'manual_review',
        }),
      ],
      evidence: {
        ocr: {
          business_license: {
            credit_code: '913607FF0000000701',
          },
        },
      },
      evidenceRefs: [
        {
          field_key: 'ocr.business_license.credit_code',
          evidence_type: 'ocr',
          source: 'ocr',
          value: '913607FF0000000701',
          confidence: 0.82,
        },
      ],
    });

    expect(result.result).toBe('manual_review');
    expect(result.failed_conditions[0].reason).toBe('low_confidence_evidence');
  });

  it('resolves $field references in target_value', () => {
    const result = evaluatePolicyConditions({
      conditions: [
        condition({
          field_key: 'ocr.business_license.credit_code',
          operator: 'eq',
          target_value: '$enterprise_profile.credit_code',
          evidence_type: 'ocr',
          fail_action: 'manual_review',
        }),
      ],
      evidence: {
        enterprise_profile: {
          credit_code: '913607FF0000000711',
        },
        ocr: {
          business_license: {
            credit_code: '913607FF0000000711',
          },
        },
      },
      evidenceRefs: [
        {
          field_key: 'ocr.business_license.credit_code',
          evidence_type: 'ocr',
          source: 'ocr',
          value: '913607FF0000000711',
          confidence: 0.96,
        },
      ],
    });

    expect(result.result).toBe('eligible');
    expect(result.matched_conditions[0].target_value).toBe('913607FF0000000711');
  });

  it('downgrades low-confidence OCR to need_info when fail_action is need_info', () => {
    const result = evaluatePolicyConditions({
      conditions: [
        condition({
          field_key: 'ocr.financial_report.revenue_amount',
          operator: 'gte',
          target_value: 5000000,
          evidence_type: 'ocr',
          fail_action: 'need_info',
        }),
      ],
      evidence: {
        ocr: {
          financial_report: {
            revenue_amount: 9000000,
          },
        },
      },
      evidenceRefs: [
        {
          field_key: 'ocr.financial_report.revenue_amount',
          evidence_type: 'ocr',
          source: 'ocr',
          value: 9000000,
          confidence: 0.84,
        },
      ],
    });

    expect(result.result).toBe('need_info');
    expect(result.failed_conditions[0].reason).toBe('low_confidence_evidence');
  });

  it('keeps meaningful chinese text when normalizing question', () => {
    expect(normalizeQuestion('南康家具企业完成数字化改造后可申请奖励'))
      .toBe('南康家具企业完成数字化改造后可申请奖励');
  });
});
