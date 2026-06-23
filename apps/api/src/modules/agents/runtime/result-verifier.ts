import { ApiError } from '../../../common/errors/http-error.js';
import { type AgentType } from '../../llm/model-registry.js';
import {
  type DocumentVisionOutput,
  type MathVerificationOutput,
  type PolicyAnalysisOutput,
  type RetrievalPlannerOutput,
  type RiskJudgeOutput,
  type SubagentOutput,
} from './subagent-registry.js';

export type VerifiedSubagentResult = {
  agent_type: AgentType;
  output: SubagentOutput;
};

export function verifySubagentResult(input: {
  agent_type: AgentType;
  output: unknown;
}): VerifiedSubagentResult {
  const value = assertRecord(input.output, input.agent_type);
  switch (input.agent_type) {
    case 'retrieval_planner':
      return {
        agent_type: input.agent_type,
        output: verifyRetrievalPlanner(value),
      };
    case 'policy_analysis':
      return {
        agent_type: input.agent_type,
        output: verifyPolicyAnalysis(value),
      };
    case 'document_vision':
      return {
        agent_type: input.agent_type,
        output: verifyDocumentVision(value),
      };
    case 'math_verification':
      return {
        agent_type: input.agent_type,
        output: verifyMathVerification(value),
      };
    case 'risk_judge':
      return {
        agent_type: input.agent_type,
        output: verifyRiskJudge(value),
      };
    default:
      throw new ApiError('FORBIDDEN', `subagent ${input.agent_type} is not supported`);
  }
}

export function verifyRiskJudgeOutput(output: unknown): RiskJudgeOutput {
  return verifyRiskJudge(assertRecord(output, 'risk_judge'));
}

function verifyRetrievalPlanner(
  value: Record<string, unknown>,
): RetrievalPlannerOutput {
  return {
    query: assertString(value.query, 'query', 'retrieval_planner'),
    policy_id: optionalString(value.policy_id, 'policy_id', 'retrieval_planner'),
    limit: optionalNumber(value.limit, 'limit', 'retrieval_planner'),
  };
}

function verifyPolicyAnalysis(
  value: Record<string, unknown>,
): PolicyAnalysisOutput {
  return {
    result: assertString(value.result, 'result', 'policy_analysis'),
    matched_conditions: optionalArray(value.matched_conditions, 'matched_conditions', 'policy_analysis'),
    missing_fields: optionalArray(value.missing_fields, 'missing_fields', 'policy_analysis'),
    explanation: assertString(value.explanation, 'explanation', 'policy_analysis'),
    answer: optionalString(value.answer, 'answer', 'policy_analysis'),
    confidence: assertConfidence(value.confidence, 'policy_analysis'),
  };
}

function verifyDocumentVision(
  value: Record<string, unknown>,
): DocumentVisionOutput {
  return {
    risk_items: assertRiskItems(value.risk_items),
    usable_as_hard_evidence: assertBoolean(
      value.usable_as_hard_evidence,
      'usable_as_hard_evidence',
      'document_vision',
    ),
    confidence: assertConfidence(value.confidence, 'document_vision'),
  };
}

function verifyMathVerification(
  value: Record<string, unknown>,
): MathVerificationOutput {
  const verdict = assertString(value.verdict, 'verdict', 'math_verification');
  if (!['pass', 'fail', 'unknown'].includes(verdict)) {
    throwInvalid('math_verification', 'verdict has invalid enum value');
  }
  return {
    verdict: verdict as MathVerificationOutput['verdict'],
    explanation: assertString(value.explanation, 'explanation', 'math_verification'),
    checked_conditions: optionalArray(value.checked_conditions, 'checked_conditions', 'math_verification'),
    confidence: assertConfidence(value.confidence, 'math_verification'),
  };
}

function verifyRiskJudge(value: Record<string, unknown>): RiskJudgeOutput {
  return {
    approved: assertBoolean(value.approved, 'approved', 'risk_judge'),
    should_fallback: assertBoolean(value.should_fallback, 'should_fallback', 'risk_judge'),
    reasons: optionalStringArray(value.reasons, 'reasons', 'risk_judge'),
    confidence: assertConfidence(value.confidence, 'risk_judge'),
  };
}

function assertRecord(value: unknown, agentType: AgentType): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throwInvalid(agentType, 'subagent output must be an object');
  }
  return value as Record<string, unknown>;
}

function assertString(
  value: unknown,
  field: string,
  agentType: AgentType,
): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throwInvalid(agentType, `${field} must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(
  value: unknown,
  field: string,
  agentType: AgentType,
): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throwInvalid(agentType, `${field} must be a string`);
  }
  return value;
}

function optionalNumber(
  value: unknown,
  field: string,
  agentType: AgentType,
): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throwInvalid(agentType, `${field} must be a number`);
  }
  return value;
}

function assertBoolean(
  value: unknown,
  field: string,
  agentType: AgentType,
): boolean {
  if (typeof value !== 'boolean') {
    throwInvalid(agentType, `${field} must be a boolean`);
  }
  return value;
}

function assertArray(
  value: unknown,
  field: string,
  agentType: AgentType,
): unknown[] {
  if (!Array.isArray(value)) {
    throwInvalid(agentType, `${field} must be an array`);
  }
  return value;
}

function optionalArray(
  value: unknown,
  field: string,
  agentType: AgentType,
): unknown[] {
  if (value === undefined) {
    return [];
  }
  return assertArray(value, field, agentType);
}

function optionalStringArray(
  value: unknown,
  field: string,
  agentType: AgentType,
): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throwInvalid(agentType, `${field} must be a string array`);
  }
  return value;
}

function assertConfidence(value: unknown, agentType: AgentType): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  ) {
    throwInvalid(agentType, 'confidence must be between 0 and 1');
  }
  return value;
}

function assertRiskItems(value: unknown): DocumentVisionOutput['risk_items'] {
  const items = assertArray(value, 'risk_items', 'document_vision');
  return items.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throwInvalid('document_vision', `risk_items[${index}] must be an object`);
    }
    const record = item as Record<string, unknown>;
    const severity = assertString(
      record.severity,
      `risk_items[${index}].severity`,
      'document_vision',
    );
    if (!['low', 'medium', 'high'].includes(severity)) {
      throwInvalid('document_vision', `risk_items[${index}].severity has invalid enum value`);
    }
    return {
      field: assertString(
        record.field,
        `risk_items[${index}].field`,
        'document_vision',
      ),
      severity: severity as 'low' | 'medium' | 'high',
      reason: assertString(
        record.reason,
        `risk_items[${index}].reason`,
        'document_vision',
      ),
    };
  });
}

function throwInvalid(agentType: AgentType, message: string): never {
  throw new ApiError(
    'VALIDATION_ERROR',
    `invalid ${agentType} subagent output: ${message}`,
  );
}
