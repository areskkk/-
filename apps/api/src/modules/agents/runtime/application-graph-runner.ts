import { ApiError } from '../../../common/errors/http-error.js';
import {
  attachFallbackTaskToRun,
  updateRunStateIfLeased,
} from '../agents.repository.js';
import { type AgentGraphState, type AgentRunRow } from '../agents.types.js';
import {
  type EligibilitySingleResult,
} from '../../eligibility/eligibility.service.js';
import {
  fallbackService,
  normalizeQuestion,
} from '../../fallback/fallback.service.js';
import { getLlmClient } from '../../llm/llm-provider.js';
import { type LlmChatResponse, type LlmTokenUsage } from '../../llm/llm.types.js';
import { resolveModelForAgent, type AgentType } from '../../llm/model-registry.js';
import { findActivePromptTemplate } from '../prompts/prompt.repository.js';
import { saveCheckpoint } from './checkpoint.repository.js';
import { agentStepRecorder } from './step-recorder.js';
import { findApplicationAgentContext } from './application-context.repository.js';
import { wrapUntrustedContent } from './agent-security.js';
import {
  type AgentOutputSchema,
  validateAgentOutput,
} from './agent-output-schema.js';
import { agentToolRunner } from '../tools/tool-runner.js';
import { type MaterialEvidenceReadToolOutput } from '../tools/material-read.tool.js';
import { agentRuntimeLoop } from './agent-runtime-loop.js';

const PROMPT_VERSION = 'batch19.v1';

type SupervisorOutput = {
  intent_type: string;
  confidence: number;
  missing_fields?: string[];
  next_node?: string;
};

type PolicyAnalysisOutput = {
  result: string;
  explanation: string;
  confidence: number;
  missing_fields?: string[];
  matched_conditions?: unknown[];
  answer?: string;
};

type ApplicationAssistOutput = {
  checklist: string[];
  missing_materials?: string[];
  confidence: number;
};

type DocumentVisionOutput = {
  risk_items: Array<{
    field: string;
    severity: 'low' | 'medium' | 'high';
    reason: string;
  }>;
  usable_as_hard_evidence: boolean;
  confidence: number;
};

type MathVerificationOutput = {
  verdict: 'pass' | 'fail' | 'unknown';
  explanation: string;
  checked_conditions?: unknown[];
  confidence: number;
};

type RiskJudgeOutput = {
  approved: boolean;
  should_fallback: boolean;
  reasons?: string[];
  confidence: number;
};

export class ApplicationGraphRunner {
  async run(input: {
    run: AgentRunRow;
    actor_id: string;
    trace_id: string;
  }): Promise<AgentRunRow> {
    return agentRuntimeLoop.runApplication(input);
  }

  async resume(input: {
    run: AgentRunRow;
    actor_id: string;
    trace_id: string;
    task_id: string;
    resume_payload: Record<string, unknown>;
  }): Promise<AgentRunRow> {
    const applicationId = readApplicationId(input.run.state);
    const itemId = readOptionalItemId(input.run.state);
    const context = await findApplicationAgentContext(applicationId, itemId);
    if (!context) {
      throw new ApiError('NOT_FOUND', 'application not found');
    }
    let state: AgentGraphState = {
      ...input.run.state,
      current_node: 'human_fallback_resume',
      fallback: {
        ...(input.run.state.fallback ?? {}),
        task_id: input.task_id,
        reason: input.run.state.fallback?.reason ?? 'application_agent_resumed',
        resume_payload: input.resume_payload,
      },
      manual_resume: normalizeApplicationResumePayload(input.resume_payload),
    };
    await agentStepRecorder.recordStep({
      run_id: input.run.run_id,
      node_name: 'human_fallback_resume',
      agent_type: 'human_fallback',
      status: 'completed',
      input: {
        task_id: input.task_id,
      },
      output: {
        resumed: true,
        resume_contract_version: 'application.v1',
      },
    });
    await saveCheckpoint({ run_id: input.run.run_id, state });

    state = applyApplicationManualResume(state, input.resume_payload);
    state = await this.runOcrTool(input.run, state, context.application_id);
    state = await this.runEligibilityTool(input, state, context);
    state = await this.runMathVerification(input.run, state);
    state = await this.runRiskJudge(input.run, state);
    if (shouldInterrupt(state)) {
      return this.interruptResumedRun(input, state, 'application_agent_resume_still_requires_review');
    } else {
      state = {
        ...state,
        current_node: 'final',
        final: {
          status: 'application_agent_completed',
          answer:
            'Application agent resumed after manual fallback. Eligibility remains rule-engine first.',
          next_actions: [],
        },
      };
    }
    await agentStepRecorder.recordStep({
      run_id: input.run.run_id,
      node_name: 'final',
      agent_type: 'final',
      status: 'completed',
      input: {
        resumed_from_task_id: input.task_id,
      },
      output: state.final,
    });
    await saveCheckpoint({
      run_id: input.run.run_id,
      state,
      status: 'completed',
    });
    return this.updateRun(input.run.run_id, 'completed', 'final', state);
  }

  private async interruptResumedRun(
    input: {
      run: AgentRunRow;
      task_id: string;
    },
    state: AgentGraphState,
    reason: string,
  ): Promise<AgentRunRow> {
    const nextState: AgentGraphState = {
      ...state,
      current_node: 'human_fallback',
      fallback: {
        ...(state.fallback ?? {}),
        task_id: input.task_id,
        reason,
      },
      final: {
        status: 'manual_review',
        answer:
          'Application agent resumed after manual fallback, but risks still require human review.',
        next_actions: ['manual_fallback'],
      },
    };
    await agentStepRecorder.recordStep({
      run_id: input.run.run_id,
      node_name: 'human_fallback',
      agent_type: 'human_fallback',
      status: 'interrupted',
      input: {
        reason,
        resumed_from_task_id: input.task_id,
      },
      output: {
        fallback_task_id: input.task_id,
        reused_existing_task: true,
      },
    });
    await saveCheckpoint({
      run_id: input.run.run_id,
      state: nextState,
      status: 'interrupted',
    });
    return this.updateRun(input.run.run_id, 'interrupted', 'human_fallback', nextState);
  }

  private async runSupervisor(
    run: AgentRunRow,
    context: {
      application_id: string;
      policy_id: string;
      application_status: string;
    },
  ): Promise<AgentGraphState> {
    const output = await this.callJsonAgent<SupervisorOutput>({
      run,
      node_name: 'supervisor',
      agent_type: 'supervisor',
      schema: 'supervisor',
      input: context,
      system_prompt: [
        'You supervise an application assistance workflow.',
        'Return JSON with intent_type, confidence, missing_fields, next_node.',
      ].join(' '),
      user_prompt: wrapUntrustedContent('application_context', context),
    });
    const state: AgentGraphState = {
      ...run.state,
      current_node: 'supervisor',
      intent: {
        intent_type: output.json?.intent_type ?? 'application_assist',
        confidence: toConfidence(output.json?.confidence),
        missing_fields: output.json?.missing_fields ?? [],
        next_node: output.json?.next_node ?? 'policy_analysis',
      },
    };
    await saveCheckpoint({ run_id: run.run_id, state });
    return state;
  }

  private async runPolicyAnalysis(
    run: AgentRunRow,
    state: AgentGraphState,
    context: {
      policy_id: string;
      policy_title: string;
      policy_version: string;
    },
  ): Promise<AgentGraphState> {
    const output = await this.callJsonAgent<PolicyAnalysisOutput>({
      run: { ...run, state },
      node_name: 'policy_analysis',
      agent_type: 'policy_analysis',
      schema: 'policy_analysis',
      input: context,
      system_prompt: [
        'You analyze application policy requirements.',
        'Do not decide eligibility. Return JSON with result, explanation, confidence, missing_fields, matched_conditions, answer.',
      ].join(' '),
      user_prompt: wrapUntrustedContent('policy_context', context),
    });
    const nextState: AgentGraphState = {
      ...state,
      current_node: 'policy_analysis',
      policy_analysis: {
        result: output.json?.result ?? 'application_policy_analyzed',
        matched_conditions: output.json?.matched_conditions ?? [],
        missing_fields: output.json?.missing_fields ?? [],
        explanation: output.json?.explanation ?? '',
        confidence: toConfidence(output.json?.confidence),
        answer: output.json?.answer,
      },
    };
    await saveCheckpoint({ run_id: run.run_id, state: nextState });
    return nextState;
  }

  private async runApplicationAssist(
    run: AgentRunRow,
    state: AgentGraphState,
    context: {
      application_id: string;
      policy_id: string;
    },
  ): Promise<AgentGraphState> {
    const output = await this.callJsonAgent<ApplicationAssistOutput>({
      run: { ...run, state },
      node_name: 'application_assist',
      agent_type: 'application_assist',
      schema: 'application_assist',
      input: context,
      system_prompt: [
        'You assist an enterprise application.',
        'Return JSON with checklist, missing_materials, confidence. Do not make approval decisions.',
      ].join(' '),
      user_prompt: wrapUntrustedContent('application_assist_input', {
        context,
        policy_analysis: state.policy_analysis,
      }),
    });
    const nextState: AgentGraphState = {
      ...state,
      current_node: 'application_assist',
      application_assist: {
        checklist: output.json?.checklist ?? [],
        missing_materials: output.json?.missing_materials ?? [],
        confidence: toConfidence(output.json?.confidence),
      },
    };
    await saveCheckpoint({ run_id: run.run_id, state: nextState });
    return nextState;
  }

  private async runOcrTool(
    run: AgentRunRow,
    state: AgentGraphState,
    applicationId: string,
  ): Promise<AgentGraphState> {
    const confirmedMaterials = Array.isArray(
      (state.manual_resume as Record<string, unknown> | undefined)?.confirmed_materials,
    )
      ? ((state.manual_resume as Record<string, unknown>).confirmed_materials as unknown[])
        .filter((item): item is string => typeof item === 'string')
      : [];
    const toolResult = await agentToolRunner.execute<MaterialEvidenceReadToolOutput>(
      'ocr.material_evidence.read',
      {
        application_id: applicationId,
        confirmed_materials: confirmedMaterials,
        mode: 'full',
      },
      {
        run_id: run.run_id,
        actor_id: run.actor_id,
        trace_id: run.trace_id ?? state.trace_id,
        agent_type: 'document_vision',
        entrypoint: 'application',
        roles: run.state.runtime?.actor?.roles,
        user_type: run.state.runtime?.actor?.user_type,
      },
    );
    const ocrResult = toolResult.output;
    const lowConfidenceMaterials = ocrResult.materials.filter(
      (material) => !material.hard_evidence_allowed,
    );
    const summaries = ocrResult.materials;
    const nextState: AgentGraphState = {
      ...state,
      current_node: 'ocr_tool',
      ocr: {
        materials: summaries,
        low_confidence_material_ids: ocrResult.low_confidence_material_ids,
        hard_evidence_notice: ocrResult.hard_evidence_notice,
      },
    };
    await agentStepRecorder.recordStep({
      run_id: run.run_id,
      node_name: 'ocr_tool',
      agent_type: 'tool',
      status: 'completed',
      input: {
        application_id: applicationId,
      },
      output: {
        material_count: summaries.length,
        low_confidence_material_count: lowConfidenceMaterials.length,
        hard_evidence_allowed_count: summaries.filter(
          (material) => material.hard_evidence_allowed,
        ).length,
      },
      tool_calls: [{
        tool_call_id: toolResult.tool_call.tool_call_id,
        tool_name: toolResult.tool_call.tool_name,
        status: toolResult.tool_call.status,
      }],
    });
    await saveCheckpoint({ run_id: run.run_id, state: nextState });
    return nextState;
  }

  private async runDocumentVision(
    run: AgentRunRow,
    state: AgentGraphState,
  ): Promise<AgentGraphState> {
    const output = await this.callJsonAgent<DocumentVisionOutput>({
      run: { ...run, state },
      node_name: 'document_vision',
      agent_type: 'document_vision',
      schema: 'document_vision',
      input: {
        low_confidence_material_ids: state.ocr?.low_confidence_material_ids ?? [],
      },
      system_prompt: [
        'You are a document vision risk agent.',
        'Use the configured VL model for low-confidence OCR evidence.',
        'Return JSON with risk_items, usable_as_hard_evidence, confidence.',
      ].join(' '),
      user_prompt: wrapUntrustedContent('ocr_evidence', {
        ocr: state.ocr,
        hard_evidence_rule:
          'Low confidence OCR must not be treated as hard evidence.',
      }),
    });
    const hasLowConfidence = (state.ocr?.low_confidence_material_ids.length ?? 0) > 0;
    const llmRiskItems = Array.isArray(output.json?.risk_items)
      ? output.json.risk_items
      : [];
    const guardrailRiskItems = hasLowConfidence
      ? [{
          field: 'ocr.low_confidence',
          severity: 'high' as const,
          reason: 'OCR confidence is below threshold; manual confirmation is required.',
        }]
      : [];
    const nextState: AgentGraphState = {
      ...state,
      current_node: 'document_vision',
      document_vision: {
        risk_items: [...guardrailRiskItems, ...llmRiskItems],
        usable_as_hard_evidence: hasLowConfidence
          ? false
          : output.json?.usable_as_hard_evidence ?? false,
        confidence: toConfidence(output.json?.confidence),
      },
    };
    await saveCheckpoint({ run_id: run.run_id, state: nextState });
    return nextState;
  }

  private async runEligibilityTool(
    input: {
      run: AgentRunRow;
      actor_id: string;
      trace_id: string;
    },
    state: AgentGraphState,
    context: {
      application_id: string;
      item_id: string;
      enterprise_id: string;
      applicant_user_id: string;
      policy_id: string;
    },
  ): Promise<AgentGraphState> {
    const toolResult = await agentToolRunner.execute<EligibilitySingleResult>(
      'eligibility.rule_engine.check',
      {
        application_id: context.application_id,
        item_id: context.item_id,
        enterprise_id: context.enterprise_id,
        applicant_user_id: context.applicant_user_id,
        policy_id: context.policy_id,
        confirmed_materials: readConfirmedMaterials(state.manual_resume),
      },
      {
        run_id: input.run.run_id,
        actor_id: input.actor_id,
        trace_id: input.trace_id,
        agent_type: 'application_assist',
        entrypoint: 'application',
        roles: input.run.state.runtime?.actor?.roles,
        user_type: input.run.state.runtime?.actor?.user_type,
      },
    );
    const result = toolResult.output;
    const nextState: AgentGraphState = {
      ...state,
      current_node: 'eligibility_tool',
      eligibility: {
        result: result.result,
        matched_conditions: result.matched_conditions,
        failed_conditions: result.failed_conditions,
        missing_fields: result.missing_fields,
        citations: result.citations,
        evidence_refs: result.evidence_refs,
        fallback_task: result.fallback_task,
        ai_summary: result.ai_summary,
        rule_first: true,
      },
    };
    await agentStepRecorder.recordStep({
      run_id: input.run.run_id,
      node_name: 'eligibility_tool',
      agent_type: 'tool',
      status: 'completed',
      input: {
        application_id: context.application_id,
        policy_id: context.policy_id,
      },
      output: {
        result: result.result,
        rule_first: true,
        failed_condition_count: result.failed_conditions.length,
        low_confidence_fields: result.failed_conditions
          .filter((condition) => condition.reason === 'low_confidence_evidence')
          .map((condition) => condition.field_key),
      },
      tool_calls: [{
        tool_call_id: toolResult.tool_call.tool_call_id,
        tool_name: toolResult.tool_call.tool_name,
        status: toolResult.tool_call.status,
      }],
    });
    await saveCheckpoint({ run_id: input.run.run_id, state: nextState });
    return nextState;
  }

  private async runMathVerification(
    run: AgentRunRow,
    state: AgentGraphState,
  ): Promise<AgentGraphState> {
    const output = await this.callJsonAgent<MathVerificationOutput>({
      run: { ...run, state },
      node_name: 'math_verification',
      agent_type: 'math_verification',
      schema: 'math_verification',
      input: {
        numeric_conditions: extractNumericConditions(state.eligibility),
      },
      system_prompt: [
        'You explain numeric policy checks.',
        'Use the configured math verification model.',
        'Return JSON with verdict, explanation, checked_conditions, confidence.',
      ].join(' '),
      user_prompt: wrapUntrustedContent('math_verification_input', {
        eligibility: state.eligibility,
        rule_first:
          'Rules decide eligibility. Math agent only explains numeric comparisons.',
      }),
    });
    const nextState: AgentGraphState = {
      ...state,
      current_node: 'math_verification',
      math_verification: {
        verdict: output.json?.verdict ?? 'unknown',
        explanation: output.json?.explanation ?? '',
        checked_conditions: output.json?.checked_conditions ?? [],
        confidence: toConfidence(output.json?.confidence),
      },
    };
    await saveCheckpoint({ run_id: run.run_id, state: nextState });
    return nextState;
  }

  private async runRiskJudge(
    run: AgentRunRow,
    state: AgentGraphState,
  ): Promise<AgentGraphState> {
    const ruleLlmConflict = hasRuleLlmConflict(state);
    const output = await this.callJsonAgent<RiskJudgeOutput>({
      run: { ...run, state },
      node_name: 'risk_judge',
      agent_type: 'risk_judge',
      schema: 'risk_judge',
      input: {
        eligibility_result: state.eligibility?.result ?? null,
        math_verdict: state.math_verification?.verdict ?? null,
        rule_llm_conflict: ruleLlmConflict,
      },
      system_prompt: [
        'You judge application agent risks.',
        'Rules override LLM outputs. Return JSON with approved, should_fallback, reasons, confidence.',
      ].join(' '),
      user_prompt: wrapUntrustedContent('risk_judge_input', {
        document_vision: state.document_vision,
        eligibility: state.eligibility,
        math_verification: state.math_verification,
        rule_llm_conflict: ruleLlmConflict,
      }),
    });
    const reasons = [
      ...(output.json?.reasons ?? []),
      ...guardrailJudgeReasons(state, ruleLlmConflict),
    ];
    const shouldFallback =
      (output.json?.should_fallback ?? true) ||
      ruleLlmConflict ||
      state.eligibility?.result === 'manual_review';
    const nextState: AgentGraphState = {
      ...state,
      current_node: 'risk_judge',
      judge: {
        approved: (output.json?.approved ?? false) && !shouldFallback,
        should_fallback: shouldFallback,
        reasons,
        confidence: toConfidence(output.json?.confidence),
      },
    };
    await saveCheckpoint({ run_id: run.run_id, state: nextState });
    return nextState;
  }

  private async callJsonAgent<TJson>(input: {
    run: AgentRunRow;
    node_name: string;
    agent_type: AgentType;
    schema: AgentOutputSchema;
    input: Record<string, unknown>;
    system_prompt: string;
    user_prompt: string;
  }): Promise<LlmChatResponse<TJson>> {
    const model = await resolveModelForAgent(input.agent_type);
    const prompt = await findActivePromptTemplate(input.agent_type);
    const response = await getLlmClient().chatCompletion<TJson>({
      model: model.model,
      messages: [
        {
          role: 'system',
          content: `${prompt?.content ?? input.system_prompt} Prompt version: ${prompt?.version ?? PROMPT_VERSION}.`,
        },
        { role: 'user', content: input.user_prompt },
      ],
      response_format: 'json_object',
      trace_id: input.run.trace_id ?? input.run.state.trace_id,
      run_id: input.run.run_id,
      agent_type: input.agent_type,
      prompt_version: prompt?.version ?? PROMPT_VERSION,
    });
    const json = validateAgentOutput({
      schema: input.schema,
      json: response.json,
      agent_type: input.agent_type,
      model: model.model,
      trace_id: input.run.trace_id ?? input.run.state.trace_id,
    }) as TJson;
    await agentStepRecorder.recordStep({
      run_id: input.run.run_id,
      node_name: input.node_name,
      agent_type: input.agent_type,
      model_name: model.model,
      prompt_template_id: prompt?.template_id ?? null,
      status: 'completed',
      input: {
        ...input.input,
        prompt_version: prompt?.version ?? PROMPT_VERSION,
        provider: model.provider,
        endpoint: model.endpoint,
        model_version: model.model_version ?? null,
        deployment_location: model.deployment_location ?? null,
      },
      output: json && typeof json === 'object'
        ? json as Record<string, unknown>
        : { content: response.content },
      token_usage: usageToRecord(response.usage),
    });
    return {
      ...response,
      json,
    };
  }

  private async interruptForFallback(
    input: {
      run: AgentRunRow;
      actor_id: string;
      trace_id: string;
    },
    state: AgentGraphState,
    reason: string,
  ): Promise<AgentRunRow> {
    const applicationId = readApplicationId(state);
    const fallback = await fallbackService.createIfNotExists({
      actor_id: input.actor_id,
      trace_id: input.trace_id,
      source_type: 'agent_run',
      source_id: input.run.run_id,
      run_id: input.run.run_id,
      reason,
      context: {
        run_id: input.run.run_id,
        application_id: applicationId,
        normalized_application_id: normalizeQuestion(applicationId),
        eligibility_result: state.eligibility?.result ?? null,
        judge: state.judge ?? null,
        document_vision: state.document_vision ?? null,
        math_verification: state.math_verification ?? null,
      },
    });
    await attachFallbackTaskToRun({
      task_id: fallback.task.task_id,
      run_id: input.run.run_id,
    });

    const nextState: AgentGraphState = {
      ...state,
      current_node: 'human_fallback',
      fallback: {
        task_id: fallback.task.task_id,
        reason,
      },
      final: {
        status: 'manual_review',
        answer:
          'Application agent found evidence or rule conflicts. Manual fallback is required.',
        next_actions: ['manual_fallback'],
      },
    };
    await agentStepRecorder.recordStep({
      run_id: input.run.run_id,
      node_name: 'human_fallback',
      agent_type: 'human_fallback',
      status: 'interrupted',
      input: {
        reason,
      },
      output: {
        fallback_task_id: fallback.task.task_id,
      },
    });
    await saveCheckpoint({
      run_id: input.run.run_id,
      state: nextState,
      status: 'interrupted',
    });

    return this.updateRun(input.run.run_id, 'interrupted', 'human_fallback', nextState);
  }

  private async updateRun(
    runId: string,
    status: 'completed' | 'interrupted',
    currentNode: string,
    state: AgentGraphState,
  ): Promise<AgentRunRow> {
    const updated = await updateRunStateIfLeased({
      run_id: runId,
      status,
      current_node: currentNode,
      state,
    });
    if (!updated) {
      throw new ApiError('CONFLICT', 'agent run worker lease lost before state update');
    }
    return updated;
  }
}

function readApplicationId(state: AgentGraphState): string {
  const applicationId = state.input.application_id;
  if (typeof applicationId !== 'string' || applicationId.trim() === '') {
    throw new ApiError('VALIDATION_ERROR', 'application_id is required');
  }
  return applicationId.trim();
}

function readOptionalItemId(state: AgentGraphState): string | undefined {
  const itemId = state.input.item_id;
  if (typeof itemId !== 'string' || itemId.trim() === '') {
    return undefined;
  }
  return itemId.trim();
}

function toConfidence(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

function usageToRecord(usage: LlmTokenUsage | null): Record<string, unknown> {
  return usage
    ? {
        prompt_tokens: usage.prompt_tokens,
        completion_tokens: usage.completion_tokens,
        total_tokens: usage.total_tokens,
      }
    : {};
}

function extractNumericConditions(eligibility: AgentGraphState['eligibility']) {
  const conditions = [
    ...(eligibility?.matched_conditions ?? []),
    ...(eligibility?.failed_conditions ?? []),
  ];
  return conditions.filter((condition) => {
    const operator = String((condition as Record<string, unknown>).operator ?? '');
    return ['gte', 'lte', 'between'].includes(operator);
  });
}

function hasRuleLlmConflict(state: AgentGraphState): boolean {
  const ruleResult = state.eligibility?.result;
  const mathVerdict = state.math_verification?.verdict;
  if (!ruleResult || !mathVerdict || mathVerdict === 'unknown') {
    return false;
  }
  if (ruleResult === 'eligible') {
    return mathVerdict === 'fail';
  }
  if (ruleResult === 'ineligible') {
    return mathVerdict === 'pass';
  }
  return false;
}

function guardrailJudgeReasons(
  state: AgentGraphState,
  ruleLlmConflict: boolean,
): string[] {
  const reasons: string[] = [];
  if ((state.ocr?.low_confidence_material_ids.length ?? 0) > 0) {
    reasons.push('low_confidence_ocr_requires_manual_confirmation');
  }
  if (ruleLlmConflict) {
    reasons.push('rule_engine_overrides_llm_conflict');
  }
  if (state.eligibility?.result === 'manual_review') {
    reasons.push('rule_engine_requires_manual_review');
  }
  return reasons;
}

function shouldInterrupt(state: AgentGraphState): boolean {
  return Boolean(state.judge?.should_fallback || !state.judge?.approved);
}

function normalizeApplicationResumePayload(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return {
    resume_contract_version: 'application.v1',
    corrected_fields: isRecord(payload.corrected_fields)
      ? payload.corrected_fields
      : {},
    confirmed_materials: Array.isArray(payload.confirmed_materials)
      ? payload.confirmed_materials.filter((item) => typeof item === 'string')
      : [],
    manual_notes: typeof payload.manual_notes === 'string'
      ? payload.manual_notes
      : '',
  };
}

function applyApplicationManualResume(
  state: AgentGraphState,
  payload: Record<string, unknown>,
): AgentGraphState {
  const confirmedMaterials = new Set(
    Array.isArray(payload.confirmed_materials)
      ? payload.confirmed_materials.filter((item): item is string => typeof item === 'string')
      : [],
  );
  const correctedFields = isRecord(payload.corrected_fields)
    ? payload.corrected_fields
    : {};
  const ocr = state.ocr
    ? {
        ...state.ocr,
        materials: state.ocr.materials.map((material) => {
          if (!confirmedMaterials.has(material.material_id)) {
            return material;
          }
          return {
            ...material,
            requires_manual_confirmation: false,
            hard_evidence_allowed: true,
            warnings: [
              ...material.warnings,
              'manually_confirmed_on_resume',
            ],
          };
        }),
        low_confidence_material_ids: state.ocr.low_confidence_material_ids
          .filter((materialId) => !confirmedMaterials.has(materialId)),
      }
    : state.ocr;

  return {
    ...state,
    ocr,
    manual_resume: {
      resume_contract_version: 'application.v1',
      corrected_fields: correctedFields,
      confirmed_materials: [...confirmedMaterials],
      manual_notes: typeof payload.manual_notes === 'string' ? payload.manual_notes : '',
    },
  };
}

function readConfirmedMaterials(manualResume: unknown): string[] {
  if (!manualResume || typeof manualResume !== 'object' || Array.isArray(manualResume)) {
    return [];
  }
  const confirmedMaterials = (manualResume as Record<string, unknown>).confirmed_materials;
  return Array.isArray(confirmedMaterials)
    ? confirmedMaterials.filter((item): item is string => typeof item === 'string')
    : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export const applicationGraphRunner = new ApplicationGraphRunner();
