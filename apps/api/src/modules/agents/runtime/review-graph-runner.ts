import { ApiError } from '../../../common/errors/http-error.js';
import { auditService } from '../../audit/audit.service.js';
import {
  type EligibilitySingleResult,
} from '../../eligibility/eligibility.service.js';
import { getLlmClient } from '../../llm/llm-provider.js';
import { type LlmChatResponse, type LlmTokenUsage } from '../../llm/llm.types.js';
import { resolveModelForAgent, type AgentType } from '../../llm/model-registry.js';
import { findActivePromptTemplate } from '../prompts/prompt.repository.js';
import { findReviewTaskByItemId } from '../../review/review.repository.js';
import { insertReviewAgentDraft } from '../../review/review-agent-drafts.repository.js';
import { updateRunStateIfLeased } from '../agents.repository.js';
import { type AgentGraphState, type AgentRunRow } from '../agents.types.js';
import { findApplicationAgentContext } from './application-context.repository.js';
import { saveCheckpoint } from './checkpoint.repository.js';
import { agentStepRecorder } from './step-recorder.js';
import { wrapUntrustedContent } from './agent-security.js';
import {
  type AgentOutputSchema,
  validateAgentOutput,
} from './agent-output-schema.js';
import { agentToolRunner } from '../tools/tool-runner.js';
import { type MaterialEvidenceReadToolOutput } from '../tools/material-read.tool.js';
import { agentRuntimeLoop } from './agent-runtime-loop.js';

const PROMPT_VERSION = 'batch20.v1';

type ReviewAgentOutput = {
  review_focus: string[];
  evidence_questions?: string[];
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

type DraftReviewOpinionOutput = {
  suggested_decision: 'approve' | 'reject' | 'request_supplement' | 'manual_review';
  opinion: string;
  missing_evidence?: string[];
  risk_items?: unknown[];
  confidence: number;
};

export class ReviewGraphRunner {
  async run(input: {
    run: AgentRunRow;
    actor_id: string;
    trace_id: string;
  }): Promise<AgentRunRow> {
    return agentRuntimeLoop.runReview(input);
  }

  async resume(input: {
    run: AgentRunRow;
    actor_id: string;
    trace_id: string;
    task_id: string;
    resume_payload: Record<string, unknown>;
  }): Promise<AgentRunRow> {
    return agentRuntimeLoop.resumeReview(input);
  }

  private async runReviewAgent(
    run: AgentRunRow,
    task: {
      item_id: string;
      application_id: string;
      policy_id: string;
      policy_title: string;
      policy_version: string;
      policy_item_status: string;
    },
  ): Promise<AgentGraphState> {
    const output = await this.callJsonAgent<ReviewAgentOutput>({
      run,
      node_name: 'review_agent',
      agent_type: 'review',
      schema: 'review',
      input: {
        item_id: task.item_id,
        application_id: task.application_id,
        policy_id: task.policy_id,
      },
      system_prompt: [
        'You are a government review assistant.',
        'Only prepare review focus. Do not approve, reject, or call final decision APIs.',
        'Return JSON with review_focus, evidence_questions, confidence.',
      ].join(' '),
      user_prompt: wrapUntrustedContent('review_task', task),
    });
    const state: AgentGraphState = {
      ...run.state,
      current_node: 'review_agent',
      review_agent: {
        review_focus: output.json?.review_focus ?? [],
        evidence_questions: output.json?.evidence_questions ?? [],
        confidence: toConfidence(output.json?.confidence),
      },
    };
    await saveCheckpoint({ run_id: run.run_id, state });
    return state;
  }

  private async runEligibilityTool(
    input: {
      run: AgentRunRow;
      actor_id: string;
      trace_id: string;
    },
    state: AgentGraphState,
    task: {
      item_id: string;
      application_id: string;
      enterprise_id: string;
      policy_id: string;
      applicant_user_id: string;
    },
  ): Promise<AgentGraphState> {
    const context = await findApplicationAgentContext(task.application_id, task.item_id);
    if (!context) {
      throw new ApiError('NOT_FOUND', 'application not found');
    }
    const toolResult = await agentToolRunner.execute<EligibilitySingleResult>(
      'eligibility.rule_engine.check',
      {
        application_id: context.application_id,
        item_id: context.item_id,
        enterprise_id: context.enterprise_id,
        applicant_user_id: task.applicant_user_id,
        policy_id: context.policy_id,
      },
      {
        run_id: input.run.run_id,
        actor_id: input.actor_id,
        trace_id: input.trace_id,
        agent_type: 'review',
        entrypoint: 'review',
        item_id: task.item_id,
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
        missing_fields: result.missing_fields,
        failed_condition_count: result.failed_conditions.length,
        rule_first: true,
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

  private async runDocumentVision(
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
        mode: 'summary',
      },
      {
        run_id: run.run_id,
        actor_id: run.actor_id,
        trace_id: run.trace_id ?? state.trace_id,
        agent_type: 'document_vision',
        entrypoint: 'review',
        item_id: readItemId(run.state),
        roles: run.state.runtime?.actor?.roles,
        user_type: run.state.runtime?.actor?.user_type,
      },
    );
    const ocrSummary = toolResult.output.materials;
    const output = await this.callJsonAgent<DocumentVisionOutput>({
      run: { ...run, state },
      node_name: 'document_vision',
      agent_type: 'document_vision',
      schema: 'document_vision',
      input: {
        material_count: ocrSummary.length,
      },
      system_prompt: [
        'You inspect submitted documents for review risks.',
        'Return JSON with risk_items, usable_as_hard_evidence, confidence.',
      ].join(' '),
      user_prompt: wrapUntrustedContent('document_vision_input', {
        ocr_summary: ocrSummary,
        rule: 'Low-confidence OCR must be listed as a risk, not hard evidence.',
      }),
    });
    const guardrailRisks = ocrSummary
      .filter((material) => material.requires_manual_confirmation)
      .map((material) => ({
        field: `material.${material.material_type}.ocr`,
        severity: 'high' as const,
        reason: 'OCR confidence requires manual confirmation.',
      }));
    const nextState: AgentGraphState = {
      ...state,
      current_node: 'document_vision',
      ocr: {
        materials: ocrSummary,
        low_confidence_material_ids: toolResult.output.low_confidence_material_ids,
        hard_evidence_notice: toolResult.output.hard_evidence_notice,
      },
      document_vision: {
        risk_items: [
          ...guardrailRisks,
          ...(Array.isArray(output.json?.risk_items) ? output.json.risk_items : []),
        ],
        usable_as_hard_evidence:
          guardrailRisks.length > 0 ? false : output.json?.usable_as_hard_evidence ?? false,
        confidence: toConfidence(output.json?.confidence),
      },
    };
    await saveCheckpoint({ run_id: run.run_id, state: nextState });
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
        'You explain numeric review conditions.',
        'Rules decide eligibility; you only explain calculations.',
        'Return JSON with verdict, explanation, checked_conditions, confidence.',
      ].join(' '),
      user_prompt: wrapUntrustedContent('math_verification_input', {
        eligibility: state.eligibility,
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
    const output = await this.callJsonAgent<RiskJudgeOutput>({
      run: { ...run, state },
      node_name: 'risk_judge',
      agent_type: 'risk_judge',
      schema: 'risk_judge',
      input: {
        eligibility_result: state.eligibility?.result ?? null,
        risk_count: state.document_vision?.risk_items.length ?? 0,
      },
      system_prompt: [
        'You judge review draft risks.',
        'Never approve automatically. Return JSON with approved, should_fallback, reasons, confidence.',
      ].join(' '),
      user_prompt: wrapUntrustedContent('risk_judge_input', {
        eligibility: state.eligibility,
        document_vision: state.document_vision,
        math_verification: state.math_verification,
      }),
    });
    const nextState: AgentGraphState = {
      ...state,
      current_node: 'risk_judge',
      judge: {
        approved: false,
        should_fallback: output.json?.should_fallback ?? true,
        reasons: [
          ...(output.json?.reasons ?? []),
          'no_auto_approval_batch20',
        ],
        confidence: toConfidence(output.json?.confidence),
      },
    };
    await saveCheckpoint({ run_id: run.run_id, state: nextState });
    return nextState;
  }

  private async runDraftReviewOpinion(
    input: {
      run: AgentRunRow;
      actor_id: string;
      trace_id: string;
    },
    state: AgentGraphState,
    task: {
      item_id: string;
      application_id: string;
    },
  ): Promise<AgentGraphState> {
    const output = await this.callJsonAgent<DraftReviewOpinionOutput>({
      run: { ...input.run, state },
      node_name: 'draft_review_opinion',
      agent_type: 'review',
      schema: 'draft_review_opinion',
      input: {
        item_id: task.item_id,
        application_id: task.application_id,
      },
      system_prompt: [
        'Draft a review opinion for a human reviewer.',
        'Do not call review.decide. Do not mutate application status.',
        'Return JSON with suggested_decision, opinion, missing_evidence, risk_items, confidence.',
      ].join(' '),
      user_prompt: wrapUntrustedContent('draft_review_opinion_input', {
        review_agent: state.review_agent,
        eligibility: state.eligibility,
        document_vision: state.document_vision,
        math_verification: state.math_verification,
        judge: state.judge,
      }),
    });
    const riskItems = [
      ...(state.document_vision?.risk_items ?? []),
      ...(Array.isArray(output.json?.risk_items) ? output.json.risk_items : []),
    ];
    const missingEvidence = [
      ...(state.eligibility?.missing_fields ?? []),
      ...(output.json?.missing_evidence ?? []),
    ];
    const draft = await insertReviewAgentDraft({
      run_id: input.run.run_id,
      item_id: task.item_id,
      application_id: task.application_id,
      reviewer_id: input.actor_id,
      suggested_decision: output.json?.suggested_decision ?? 'manual_review',
      opinion: output.json?.opinion ?? 'Agent draft requires manual reviewer confirmation.',
      risk_items: riskItems,
      missing_evidence: missingEvidence,
      reasoning: {
        no_auto_decision: true,
        eligibility_result: state.eligibility?.result ?? null,
        math_explanation: state.math_verification?.explanation ?? null,
        judge: state.judge ?? null,
      },
      agent_outputs: {
        review_agent: state.review_agent ?? null,
        eligibility: state.eligibility ?? null,
        document_vision: state.document_vision ?? null,
        math_verification: state.math_verification ?? null,
        risk_judge: state.judge ?? null,
        draft_review_opinion: output.json ?? null,
      },
    });
    await auditService.write({
      actor_id: input.actor_id,
      action: 'review.agent_draft.generate',
      target_type: 'review_agent_draft',
      target_id: draft.draft_id,
      trace_id: input.trace_id,
      detail: {
        run_id: input.run.run_id,
        item_id: task.item_id,
        application_id: task.application_id,
        suggested_decision: draft.suggested_decision,
        risk_count: riskItems.length,
        missing_evidence_count: missingEvidence.length,
        no_auto_decision: true,
      },
    });

    const nextState: AgentGraphState = {
      ...state,
      current_node: 'draft_review_opinion',
      review_draft: {
        draft_id: draft.draft_id,
        status: draft.status,
        suggested_decision: draft.suggested_decision,
        opinion: draft.opinion,
        risk_items: draft.risk_items,
        missing_evidence: draft.missing_evidence,
        no_auto_decision: true,
      },
      final: {
        status: 'draft_generated',
        answer: draft.opinion,
        next_actions: ['human_reviewer_adopt_revise_or_ignore'],
      },
    };
    await saveCheckpoint({ run_id: input.run.run_id, state: nextState });
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

  private async updateRun(
    runId: string,
    status: 'completed',
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

function readItemId(state: AgentGraphState): string {
  const itemId = state.input.item_id;
  if (typeof itemId !== 'string' || itemId.trim() === '') {
    throw new ApiError('VALIDATION_ERROR', 'item_id is required');
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

function normalizeReviewResumePayload(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return {
    resume_contract_version: 'review.v1',
    confirmed_materials: Array.isArray(payload.confirmed_materials)
      ? payload.confirmed_materials.filter((item) => typeof item === 'string')
      : [],
    reviewer_notes: typeof payload.reviewer_notes === 'string'
      ? payload.reviewer_notes
      : '',
  };
}

function applyReviewManualResume(
  state: AgentGraphState,
  payload: Record<string, unknown>,
): AgentGraphState {
  const confirmedMaterials = new Set(
    Array.isArray(payload.confirmed_materials)
      ? payload.confirmed_materials.filter((item): item is string => typeof item === 'string')
      : [],
  );
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
    manual_resume: normalizeReviewResumePayload(payload),
  };
}

export const reviewGraphRunner = new ReviewGraphRunner();
