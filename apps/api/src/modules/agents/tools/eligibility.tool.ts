import {
  eligibilityService,
  type EligibilitySingleResult,
} from '../../eligibility/eligibility.service.js';
import {
  AgentToolError,
  type AgentToolContext,
  type AgentToolDefinition,
} from './tool.types.js';

type EligibilityRuleEngineToolInput = {
  application_id: string;
  item_id: string;
  enterprise_id: string;
  applicant_user_id: string;
  policy_id: string;
  confirmed_materials: string[];
};

export const eligibilityRuleEngineTool: AgentToolDefinition<
  EligibilityRuleEngineToolInput,
  EligibilitySingleResult
> = {
  name: 'eligibility.rule_engine.check',
  description: 'Run rule-first eligibility verification for an application item.',
  allowedAgents: ['application_assist', 'review', 'risk_judge'],
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: [
      'application_id',
      'item_id',
      'enterprise_id',
      'applicant_user_id',
      'policy_id',
    ],
    properties: {
      application_id: { type: 'string' },
      item_id: { type: 'string' },
      enterprise_id: { type: 'string' },
      applicant_user_id: { type: 'string' },
      policy_id: { type: 'string' },
      confirmed_materials: {
        type: 'array',
        items: { type: 'string' },
      },
    },
  },
  validateInput(input) {
    const value = assertRecord(input);
    return {
      application_id: assertNonEmptyString(value.application_id, 'application_id'),
      item_id: assertNonEmptyString(value.item_id, 'item_id'),
      enterprise_id: assertNonEmptyString(value.enterprise_id, 'enterprise_id'),
      applicant_user_id: assertNonEmptyString(
        value.applicant_user_id,
        'applicant_user_id',
      ),
      policy_id: assertNonEmptyString(value.policy_id, 'policy_id'),
      confirmed_materials: Array.isArray(value.confirmed_materials)
        ? value.confirmed_materials.filter((item): item is string => typeof item === 'string')
        : [],
    };
  },
  async execute(input, context) {
    const result = await eligibilityService.check(
      input.applicant_user_id,
      context.trace_id,
      {
        application_id: input.application_id,
        item_id: input.item_id,
        enterprise_id: input.enterprise_id,
        policy_id: input.policy_id,
        confirmed_materials: input.confirmed_materials,
      },
    );
    return 'results' in result ? result.results[0] : result;
  },
  summarizeOutput(output) {
    return {
      result: output.result,
      matched_condition_count: output.matched_conditions.length,
      failed_condition_count: output.failed_conditions.length,
      missing_field_count: output.missing_fields.length,
      rule_first: true,
    };
  },
};

function assertRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentToolError({
      type: 'invalid_input',
      message: 'tool input must be an object',
    });
  }
  return value as Record<string, unknown>;
}

function assertNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AgentToolError({
      type: 'invalid_input',
      message: `${field} is required`,
    });
  }
  return value.trim();
}
