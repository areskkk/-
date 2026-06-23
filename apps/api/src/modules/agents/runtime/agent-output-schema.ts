import { LlmError } from '../../llm/llm.types.js';
import { type AgentType } from '../../llm/model-registry.js';

export type AgentOutputSchema =
  | 'supervisor'
  | 'retrieval_planner'
  | 'policy_analysis'
  | 'application_assist'
  | 'document_vision'
  | 'math_verification'
  | 'risk_judge'
  | 'review'
  | 'draft_review_opinion';

export function validateAgentOutput(input: {
  schema: AgentOutputSchema;
  json: unknown;
  agent_type: AgentType;
  model: string;
  trace_id?: string;
}): Record<string, unknown> {
  const value = assertObject(input);
  switch (input.schema) {
    case 'supervisor':
      assertString(value, 'intent_type', input);
      assertConfidence(value, input);
      assertOptionalStringArray(value, 'missing_fields', input);
      assertOptionalString(value, 'next_node', input);
      break;
    case 'retrieval_planner':
      assertString(value, 'query', input);
      assertOptionalString(value, 'policy_id', input, true);
      assertOptionalNumber(value, 'limit', input);
      break;
    case 'policy_analysis':
      assertString(value, 'result', input);
      assertString(value, 'explanation', input);
      assertConfidence(value, input);
      assertOptionalArray(value, 'missing_fields', input);
      assertOptionalArray(value, 'matched_conditions', input);
      assertOptionalString(value, 'answer', input);
      break;
    case 'application_assist':
      assertStringArray(value, 'checklist', input);
      assertOptionalStringArray(value, 'missing_materials', input);
      assertConfidence(value, input);
      break;
    case 'document_vision':
      assertArray(value, 'risk_items', input);
      assertBoolean(value, 'usable_as_hard_evidence', input);
      assertConfidence(value, input);
      break;
    case 'math_verification':
      assertEnum(value, 'verdict', ['pass', 'fail', 'unknown'], input);
      assertString(value, 'explanation', input);
      assertOptionalArray(value, 'checked_conditions', input);
      assertConfidence(value, input);
      break;
    case 'risk_judge':
      assertBoolean(value, 'approved', input);
      assertBoolean(value, 'should_fallback', input);
      assertOptionalStringArray(value, 'reasons', input);
      assertConfidence(value, input);
      break;
    case 'review':
      assertStringArray(value, 'review_focus', input);
      assertOptionalStringArray(value, 'evidence_questions', input);
      assertConfidence(value, input);
      break;
    case 'draft_review_opinion':
      assertEnum(
        value,
        'suggested_decision',
        ['approve', 'reject', 'request_supplement', 'manual_review'],
        input,
      );
      assertString(value, 'opinion', input);
      assertOptionalArray(value, 'missing_evidence', input);
      assertOptionalArray(value, 'risk_items', input);
      assertConfidence(value, input);
      break;
  }

  return value;
}

function assertObject(input: {
  json: unknown;
  agent_type: AgentType;
  model: string;
  trace_id?: string;
}): Record<string, unknown> {
  if (input.json === null || typeof input.json !== 'object' || Array.isArray(input.json)) {
    throwInvalid(input, 'agent output must be a json object');
  }
  return input.json as Record<string, unknown>;
}

function assertString(
  value: Record<string, unknown>,
  field: string,
  context: ErrorContext,
): void {
  if (typeof value[field] !== 'string' || (value[field] as string).trim() === '') {
    throwInvalid(context, `agent output field ${field} must be a non-empty string`);
  }
}

function assertOptionalString(
  value: Record<string, unknown>,
  field: string,
  context: ErrorContext,
  nullable = false,
): void {
  if (value[field] === undefined || (nullable && value[field] === null)) {
    return;
  }
  if (typeof value[field] !== 'string') {
    throwInvalid(context, `agent output field ${field} must be a string`);
  }
}

function assertBoolean(
  value: Record<string, unknown>,
  field: string,
  context: ErrorContext,
): void {
  if (typeof value[field] !== 'boolean') {
    throwInvalid(context, `agent output field ${field} must be a boolean`);
  }
}

function assertArray(
  value: Record<string, unknown>,
  field: string,
  context: ErrorContext,
): void {
  if (!Array.isArray(value[field])) {
    throwInvalid(context, `agent output field ${field} must be an array`);
  }
}

function assertOptionalArray(
  value: Record<string, unknown>,
  field: string,
  context: ErrorContext,
): void {
  if (value[field] === undefined) {
    return;
  }
  assertArray(value, field, context);
}

function assertStringArray(
  value: Record<string, unknown>,
  field: string,
  context: ErrorContext,
): void {
  assertArray(value, field, context);
  if (!(value[field] as unknown[]).every((item) => typeof item === 'string')) {
    throwInvalid(context, `agent output field ${field} must contain strings`);
  }
}

function assertOptionalStringArray(
  value: Record<string, unknown>,
  field: string,
  context: ErrorContext,
): void {
  if (value[field] === undefined) {
    return;
  }
  assertStringArray(value, field, context);
}

function assertOptionalNumber(
  value: Record<string, unknown>,
  field: string,
  context: ErrorContext,
): void {
  if (value[field] === undefined) {
    return;
  }
  if (typeof value[field] !== 'number' || !Number.isFinite(value[field])) {
    throwInvalid(context, `agent output field ${field} must be a number`);
  }
}

function assertConfidence(
  value: Record<string, unknown>,
  context: ErrorContext,
): void {
  const confidence = value.confidence;
  if (
    typeof confidence !== 'number' ||
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 1
  ) {
    throwInvalid(context, 'agent output field confidence must be between 0 and 1');
  }
}

function assertEnum(
  value: Record<string, unknown>,
  field: string,
  allowed: string[],
  context: ErrorContext,
): void {
  if (typeof value[field] !== 'string' || !allowed.includes(value[field] as string)) {
    throwInvalid(context, `agent output field ${field} has invalid enum value`);
  }
}

type ErrorContext = {
  agent_type: AgentType;
  model: string;
  trace_id?: string;
};

function throwInvalid(context: ErrorContext, message: string): never {
  throw new LlmError({
    type: 'invalid_response',
    message,
    retryable: false,
    provider: 'agent_runtime',
    model: context.model,
    trace_id: context.trace_id,
  });
}
