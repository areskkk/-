import { ApiError } from '../../../common/errors/http-error.js';
import { getLlmClient } from '../../llm/llm-provider.js';
import { type LlmMessage, type LlmTokenUsage } from '../../llm/llm.types.js';
import { resolveModelForAgent, type AgentType } from '../../llm/model-registry.js';
import { type RagSearchResult, type RagCitation } from '../../rag/rag.types.js';
import { type EligibilitySingleResult } from '../../eligibility/eligibility.service.js';
import { auditService } from '../../audit/audit.service.js';
import {
  createPolicyQaSourceId,
  fallbackService,
  normalizeQuestion,
} from '../../fallback/fallback.service.js';
import { findReviewTaskByItemId } from '../../review/review.repository.js';
import { insertReviewAgentDraft } from '../../review/review-agent-drafts.repository.js';
import {
  attachFallbackTaskToRun,
  updateRunStateIfLeased,
} from '../agents.repository.js';
import { type AgentGraphState, type AgentRunRow, type AgentRunStatus } from '../agents.types.js';
import { findActivePromptTemplate } from '../prompts/prompt.repository.js';
import { agentToolRunner } from '../tools/tool-runner.js';
import { type AgentToolName } from '../tools/tool.types.js';
import { type MaterialEvidenceReadToolOutput } from '../tools/material-read.tool.js';
import { validateAgentAction, type AgentAction } from './agent-action-schema.js';
import {
  type AgentOutputSchema,
  validateAgentOutput,
} from './agent-output-schema.js';
import { wrapUntrustedContent } from './agent-security.js';
import {
  type ApplicationAgentContextRow,
  findApplicationAgentContext,
  countApplicationPolicyItems,
} from './application-context.repository.js';
import { saveCheckpoint } from './checkpoint.repository.js';
import { executeSubagentFanOut } from './fanout-executor.js';
import { buildCrossDomainRoute } from './cross-domain-routing.js';
import { saveNestedRuntimeCheckpoint } from './nested-runtime-checkpoint.js';
import {
  classifyRuntimeSideEffect,
  requireApprovalForSideEffect,
  resumeAfterApproval,
} from './approval-gate.js';
import { runCompensationForFailedTool } from './compensation-runner.js';
import {
  assertCrossDomainAllowed,
  buildDefaultOrchestrationContract,
  resolveCrossDomainArtifactPolicy,
  type OrchestrationContract,
} from './orchestration-governance.js';
import { runArbitrationStrategy } from './arbitration-strategies.js';
import {
  assertPhaseActionAllowed,
  assertPhaseAgentAllowed,
  type AgentPhase,
} from './phase-policy.js';
import { aggregateSubagentResults } from './result-aggregator.js';
import { verifySubagentResult, verifyRiskJudgeOutput } from './result-verifier.js';
import { selectWorkersForGoal } from './coordinator-registry.js';
import { agentStepRecorder } from './step-recorder.js';
import {
  beginSagaStep,
  completeSagaStep,
  failSagaStep,
} from './saga-orchestrator.js';
import {
  assertSubagentPermission,
  buildSubagentPermissionScope,
  DEFAULT_SUBAGENT_BUDGET,
  getSubagentDefinition,
  normalizeDelegatedSubagents,
  type DocumentVisionOutput,
  type MathVerificationOutput,
  type PolicyAnalysisOutput,
  type RetrievalPlannerOutput,
  type RiskJudgeOutput,
  type SubagentOutput,
  type SubagentPermissionScope,
} from './subagent-registry.js';
import { getArtifactWritesForAgent, type ArtifactKey } from './artifact-graph.js';
import {
  decideToolSideEffect,
  type ToolSemanticDecision,
  requireToolSemanticDefinition,
} from './tool-semantic-registry.js';
import {
  assertTenantCapabilityAllowed,
  buildTenantPolicy,
} from './platform-ecosystem.js';

const PROMPT_VERSION = 'batch23.runtime-loop.v1';
const DEFAULT_MAX_TURNS = 6;

type RuntimeLoopResult = {
  run: AgentRunRow;
  state: AgentGraphState;
};

type ReviewTaskRuntimeContext = {
  item_id: string;
  application_id: string;
  enterprise_id: string;
  applicant_user_id: string;
  policy_id: string;
  policy_title: string;
  policy_version: string;
  policy_item_status: string;
};

export class AgentRuntimeLoop {
  async runConsultation(input: {
    run: AgentRunRow;
    actor_id: string;
    trace_id: string;
  }): Promise<AgentRunRow> {
    const question = readQuestion(input.run.state);
    const policyId = typeof input.run.state.input.policy_id === 'string'
      ? input.run.state.input.policy_id.trim()
      : '';
    if (policyId) {
      assertTenantCapabilityAllowed({
        tenant: readTenantPolicy(input.run.state),
        tool_name: 'rag.search',
        plugin_id: 'core.agent-runtime',
      });
    }
    const result = await this.run({
      run: input.run,
      actor_id: input.actor_id,
      trace_id: input.trace_id,
      phase: 'consultation',
      agent_type: 'supervisor',
      system_prompt: [
        'You are a consultation coordinator agent.',
        'Choose exactly one JSON action each turn.',
        'Allowed actions are call_tool, delegate_subagent, update_plan, respond_final, request_human, stop_run.',
        'Use delegate_subagent when specialist retrieval or policy analysis should run under the orchestration contract.',
        'Use call_tool with rag.search when policy citations are needed.',
        'After receiving citations, respond_final with a grounded answer.',
        'If citations are missing or confidence is insufficient, request_human.',
        'Never invent citations.',
      ].join(' '),
      user_prompt: wrapUntrustedContent('consultation_runtime_input', {
        question,
        policy_id: policyId || null,
      }),
      max_turns: readMaxTurns(input.run.state),
      tool_scope: {
        policy_id: typeof input.run.state.input.policy_id === 'string'
          ? input.run.state.input.policy_id
          : undefined,
      },
    });
    return result.run;
  }

  async runApplication(input: {
    run: AgentRunRow;
    actor_id: string;
    trace_id: string;
  }): Promise<AgentRunRow> {
    const applicationId = readApplicationId(input.run.state);
    const itemId = readOptionalItemId(input.run.state);
    const itemCount = await countApplicationPolicyItems(applicationId);
    if (itemCount > 1 && !itemId) {
      throw new ApiError(
        'VALIDATION_ERROR',
        'item_id is required for multi-policy application agent runs',
      );
    }
    const context = await findApplicationAgentContext(applicationId, itemId);
    if (!context) {
      throw new ApiError('NOT_FOUND', 'application not found');
    }
    const result = await this.run({
      run: input.run,
      actor_id: input.actor_id,
      trace_id: input.trace_id,
      phase: 'application',
      agent_type: 'application_assist',
      system_prompt: [
        'You are an application runtime coordinator agent.',
        'Choose exactly one JSON action each turn.',
        'Allowed actions are call_tool, delegate_subagent, update_plan, respond_final, request_human, stop_run.',
        'Use delegate_subagent for document_vision and math_verification under the orchestration contract.',
        'Use call_tool with ocr.material_evidence.read to inspect application materials.',
        'Use call_tool with eligibility.rule_engine.check to run rule-first eligibility.',
        'Do not make approval decisions or change application status.',
        'If rule, OCR, or confidence guardrails require manual review, request_human.',
      ].join(' '),
      user_prompt: wrapUntrustedContent('application_runtime_input', {
        application_id: context.application_id,
        item_id: context.item_id,
        policy_id: context.policy_id,
        policy_title: context.policy_title,
        application_status: context.application_status,
      }),
      max_turns: readMaxTurns(input.run.state),
      tool_scope: {
        application: context,
        manual_resume: input.run.state.manual_resume,
      },
    });
    return result.run;
  }

  async runReview(input: {
    run: AgentRunRow;
    actor_id: string;
    trace_id: string;
  }): Promise<AgentRunRow> {
    const itemId = readItemId(input.run.state);
    const task = await findReviewTaskByItemId(itemId);
    if (!task) {
      throw new ApiError('NOT_FOUND', 'review task not found');
    }
    const context: ReviewTaskRuntimeContext = {
      item_id: task.item_id,
      application_id: task.application_id,
      enterprise_id: task.enterprise_id,
      applicant_user_id: task.applicant_user_id,
      policy_id: task.policy_id,
      policy_title: task.policy_title,
      policy_version: task.policy_version,
      policy_item_status: task.policy_item_status,
    };
    const result = await this.run({
      run: input.run,
      actor_id: input.actor_id,
      trace_id: input.trace_id,
      phase: 'review',
      agent_type: 'review',
      system_prompt: [
        'You are a government review drafting agent.',
        'Choose exactly one JSON action each turn.',
        'Allowed actions are call_tool, delegate_subagent, update_plan, respond_final, request_human, stop_run.',
        'Use delegate_subagent for evidence review workers under the orchestration contract.',
        'Use call_tool with ocr.material_evidence.read to inspect material summaries.',
        'Use call_tool with eligibility.rule_engine.check to run rule-first eligibility.',
        'Use respond_final only to draft a review opinion for a human reviewer.',
        'Never approve, reject, adopt, or mutate review/application status.',
      ].join(' '),
      user_prompt: wrapUntrustedContent('review_runtime_input', {
        item_id: context.item_id,
        application_id: context.application_id,
        policy_id: context.policy_id,
        policy_title: context.policy_title,
        policy_item_status: context.policy_item_status,
      }),
      max_turns: readMaxTurns(input.run.state),
      tool_scope: {
        review: context,
        manual_resume: input.run.state.manual_resume,
      },
    });
    return result.run;
  }

  async resumeReview(input: {
    run: AgentRunRow;
    actor_id: string;
    trace_id: string;
    task_id: string;
    resume_payload: Record<string, unknown>;
  }): Promise<AgentRunRow> {
    const approvedState = applyApprovalResume(input.run.state, {
      actor_id: input.actor_id,
      resume_payload: input.resume_payload,
    });
    const state: AgentGraphState = {
      ...approvedState,
      current_node: 'human_fallback_resume',
      fallback: {
        ...(input.run.state.fallback ?? {}),
        task_id: input.task_id,
        reason: input.run.state.fallback?.reason ?? 'review_agent_resumed',
        resume_payload: input.resume_payload,
      },
      manual_resume: normalizeReviewResumePayload(input.resume_payload),
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
        resume_contract_version: 'review.runtime.v1',
      },
    });
    await saveCheckpoint({ run_id: input.run.run_id, state });
    return this.runReview({
      run: {
        ...input.run,
        state,
      },
      actor_id: input.actor_id,
      trace_id: input.trace_id,
    });
  }

  async resumePendingToolApproval(input: {
    run: AgentRunRow;
    actor_id: string;
    trace_id: string;
    resume_payload: Record<string, unknown>;
  }): Promise<AgentRunRow> {
    const pending = readPendingToolApproval(input.run.state);
    if (!pending) {
      throw new ApiError('CONFLICT', 'no pending tool approval exists for this run');
    }
    const approvalId = normalizeString(input.resume_payload.approval_id);
    if (approvalId && approvalId !== pending.approval_id) {
      throw new ApiError('CONFLICT', 'approval_id does not match pending tool approval');
    }
    const approval = readApprovalRequest(input.run.state, pending.approval_id);
    if (!approval) {
      throw new ApiError('NOT_FOUND', 'approval request not found');
    }
    if (approval.status === 'rejected') {
      const rejectedState: AgentGraphState = {
        ...input.run.state,
        current_node: 'runtime_tool_approval_rejected',
        runtime: {
          ...(input.run.state.runtime ?? {}),
          pending_tool_approval: {
            ...pending,
            status: 'rejected',
            rejection_reason: normalizeString(approval.comment) ?? 'tool approval rejected',
            decided_at: normalizeString(approval.decided_at),
          },
        },
        errors: [
          ...(input.run.state.errors ?? []),
          {
            node: 'runtime_tool_approval',
            message: 'tool approval rejected',
          },
        ],
      };
      await agentStepRecorder.recordStep({
        run_id: input.run.run_id,
        node_name: 'runtime_tool_approval_rejected',
        agent_type: pending.agent_type,
        status: 'interrupted',
        input: {
          approval_id: pending.approval_id,
          tool_name: pending.action.tool_name,
        },
        output: {
          executed: false,
          reason: rejectedState.runtime?.pending_tool_approval?.rejection_reason,
        },
      });
      await saveCheckpoint({
        run_id: input.run.run_id,
        state: rejectedState,
        status: 'interrupted',
      });
      return this.updateRun(
        input.run.run_id,
        'interrupted',
        'runtime_tool_approval_rejected',
        rejectedState,
      );
    }
    if (approval.status !== 'approved') {
      throw new ApiError('CONFLICT', 'pending tool approval has not been approved');
    }
    const phase = toAgentPhase(pending.phase);
    const agentType = toAgentType(pending.agent_type);
    const action = toPendingToolAction(pending.action);
    const toolScope = await this.rebuildPendingToolScope({
      pending,
      manual_resume: input.resume_payload,
    });
    const executionState: AgentGraphState = {
      ...input.run.state,
      current_node: 'runtime_tool_approval_resume',
      runtime: {
        ...(input.run.state.runtime ?? {}),
        phase,
        active_agent: agentType,
        pending_tool_approval: {
          ...pending,
          status: 'approved',
          decided_at: normalizeString(approval.decided_at),
        },
      },
    };
    const toolExecution = await this.executeToolAction({
      run: input.run,
      state: executionState,
      actor_id: input.actor_id,
      trace_id: input.trace_id,
      phase,
      agent_type: agentType,
      action,
      tool_scope: toolScope,
      approval_override: {
        approval_id: pending.approval_id,
      },
    });
    let state = mergeToolResultState(
      {
        ...toolExecution.saga_state,
        runtime: {
          ...(toolExecution.saga_state.runtime ?? {}),
          pending_tool_approval: {
            ...pending,
            status: 'completed',
            decided_at: normalizeString(approval.decided_at),
          },
          tool_semantics: {
            ...(toolExecution.saga_state.runtime?.tool_semantics ?? {}),
            [action.tool_name]: toolExecution.semantic_decision,
          },
        },
      },
      action.tool_name,
      toolExecution.output,
      phase,
    );
    await agentStepRecorder.recordStep({
      run_id: input.run.run_id,
      node_name: 'runtime_tool_approval_resume',
      agent_type: pending.agent_type,
      status: 'completed',
      input: {
        approval_id: pending.approval_id,
        tool_name: action.tool_name,
      },
      output: {
        executed: true,
        saga: state.runtime?.saga ?? null,
      },
      tool_calls: [{
        tool_call_id: toolExecution.tool_call.tool_call_id,
        tool_name: toolExecution.tool_call.tool_name,
        status: toolExecution.tool_call.status,
      }],
    });
    await saveCheckpoint({ run_id: input.run.run_id, state });
    state = await this.applyPostToolReviewDocumentVision({
      run: input.run,
      phase,
      action,
      state,
    });
    state = await this.applyPostToolApplicationGuards({
      run: input.run,
      phase,
      action,
      state,
    });
    await saveCheckpoint({
      run_id: input.run.run_id,
      state,
      status: 'completed',
    });
    return this.updateRun(input.run.run_id, 'completed', 'runtime_call_tool', state);
  }

  private async run(input: {
    run: AgentRunRow;
    actor_id: string;
    trace_id: string;
    phase: AgentPhase;
    agent_type: AgentType;
    system_prompt: string;
    user_prompt: string;
    max_turns: number;
    tool_scope: {
      policy_id?: string;
      application?: ApplicationAgentContextRow;
      review?: ReviewTaskRuntimeContext;
      manual_resume?: unknown;
    };
  }): Promise<RuntimeLoopResult> {
    const contract = resolveOrchestrationContract(input.run.state, input.phase);
    assertPhaseAgentAllowed({
      phase: input.phase,
      agent_type: input.agent_type,
    });
    let state: AgentGraphState = {
      ...input.run.state,
      runtime: {
        ...(input.run.state.runtime ?? {}),
        orchestration_contract: contract,
        phase: input.phase,
        active_agent: input.agent_type,
        max_turns: input.max_turns,
        turn_count: input.run.state.runtime?.turn_count ?? 0,
      },
    };
    let messages: LlmMessage[] = [
      {
        role: 'system',
        content: `${input.system_prompt} Prompt version: ${PROMPT_VERSION}.`,
      },
      { role: 'user', content: input.user_prompt },
    ];

    for (let turn = 1; turn <= input.max_turns; turn += 1) {
      const actionResult = await this.callActionAgent({
        run: {
          ...input.run,
          state,
        },
        agent_type: input.agent_type,
        messages,
      });
      const action = actionResult.action;
      assertPhaseActionAllowed({
        phase: input.phase,
        action,
      });
      const turnState = withRuntimeTurn(state, {
        phase: input.phase,
        active_agent: input.agent_type,
        turn_count: turn,
      });

      if (action.action === 'update_plan') {
        state = {
          ...turnState,
          plan: {
            ...(isRecord(turnState.plan) ? turnState.plan : {}),
            current_hypothesis: action.plan_update,
            open_tasks: action.open_tasks ?? [],
            completed_tasks: action.completed_tasks ?? [],
          },
        };
        messages = appendActionObservation(messages, action, {
          plan_updated: true,
        });
        await this.recordRuntimeStep({
          run: input.run,
          node_name: 'runtime_update_plan',
          action,
          state,
          token_usage: actionResult.response.usage,
        });
        continue;
      }

      if (action.action === 'delegate_subagent') {
        state = await this.executeSubagentDelegation({
          run: input.run,
          phase: input.phase,
          action,
          state: turnState,
          tool_scope: input.tool_scope,
          contract,
        });
        messages = appendActionObservation(messages, action, {
          delegated_subagents: state.runtime?.subagents ?? [],
          verifier: state.runtime?.verifier ?? null,
        });
        await this.recordRuntimeStep({
          run: input.run,
          node_name: 'runtime_delegate_subagent',
          action,
          state,
          token_usage: actionResult.response.usage,
        });
        await saveCheckpoint({ run_id: input.run.run_id, state });
        continue;
      }

      if (action.action === 'call_tool') {
        let toolExecution: Awaited<ReturnType<typeof this.executeToolAction>>;
        try {
          toolExecution = await this.executeToolAction({
            run: input.run,
            state: turnState,
            actor_id: input.actor_id,
            trace_id: input.trace_id,
            phase: input.phase,
            agent_type: input.agent_type,
            action,
            tool_scope: input.tool_scope,
          });
        } catch (error) {
          if (error instanceof ToolApprovalRequiredInterrupt) {
            const interrupted = await this.interruptForToolApproval({
              run: input.run,
              state: error.state,
              action,
              phase: input.phase,
              token_usage: actionResult.response.usage,
              decision: error.decision,
            });
            return {
              run: interrupted,
              state: error.state,
            };
          }
          const sagaState = readErrorRecord(error).saga_state;
          if (isAgentGraphState(sagaState)) {
            await saveCheckpoint({
              run_id: input.run.run_id,
              state: sagaState,
              status: 'tool_failed_compensated',
            });
          }
          throw error;
        }
        state = mergeToolResultState(
          {
            ...toolExecution.saga_state,
            runtime: {
              ...(toolExecution.saga_state.runtime ?? {}),
              tool_semantics: {
                ...(toolExecution.saga_state.runtime?.tool_semantics ?? {}),
                [action.tool_name]: toolExecution.semantic_decision,
              },
            },
          },
          action.tool_name,
          toolExecution.output,
          input.phase,
        );
        messages = appendActionObservation(messages, action, toolExecution.output);
        await this.recordRuntimeStep({
          run: input.run,
          node_name: 'runtime_call_tool',
          action,
          state,
          token_usage: actionResult.response.usage,
          tool_calls: [{
            tool_call_id: toolExecution.tool_call.tool_call_id,
            tool_name: toolExecution.tool_call.tool_name,
            status: toolExecution.tool_call.status,
          }],
        });
        await saveCheckpoint({ run_id: input.run.run_id, state });
        state = await this.applyPostToolReviewDocumentVision({
          run: input.run,
          phase: input.phase,
          action,
          state,
        });
        state = await this.applyPostToolApplicationGuards({
          run: input.run,
          phase: input.phase,
          action,
          state,
        });
        const autoInterrupt = getApplicationGuardrailInterrupt(input.phase, state);
        if (autoInterrupt) {
          return {
            run: await this.interruptForHuman({
              run: input.run,
              actor_id: input.actor_id,
              trace_id: input.trace_id,
              phase: input.phase,
              state,
              reason: autoInterrupt.reason,
              context: autoInterrupt.context,
            }),
            state,
          };
        }
        continue;
      }

      if (action.action === 'respond_final') {
        if (input.phase === 'review') {
          return {
            run: await this.completeReviewDraft({
              run: input.run,
              actor_id: input.actor_id,
              trace_id: input.trace_id,
              state: turnState,
              action,
              review: requireReviewToolScope(input.tool_scope),
              token_usage: actionResult.response.usage,
            }),
            state: turnState,
          };
        }
        const finalGate = getFinalGateInterrupt(input.phase, turnState);
        if (finalGate) {
          return {
            run: await this.interruptForHuman({
              run: input.run,
              actor_id: input.actor_id,
              trace_id: input.trace_id,
              phase: input.phase,
              state: turnState,
              reason: finalGate.reason,
              context: finalGate.context,
            }),
            state: turnState,
          };
        }
        state = buildFinalState(turnState, action, input.phase);
        await this.recordRuntimeStep({
          run: input.run,
          node_name: 'runtime_final',
          action,
          state,
          token_usage: actionResult.response.usage,
        });
        await saveCheckpoint({
          run_id: input.run.run_id,
          state,
          status: 'completed',
        });
        return {
          run: await this.updateRun(input.run.run_id, 'completed', 'final', state),
          state,
        };
      }

      if (action.action === 'request_human') {
        return {
          run: await this.interruptForHuman({
            run: input.run,
            actor_id: input.actor_id,
            trace_id: input.trace_id,
            phase: input.phase,
            state: turnState,
            reason: action.reason,
            context: action.context,
          }),
          state: turnState,
        };
      }

      if (action.action === 'stop_run') {
        const stopStatus = action.status ?? 'failed';
        state = {
          ...turnState,
          current_node: 'stopped',
          errors: [
            ...(turnState.errors ?? []),
            {
              node: 'runtime_loop',
              message: action.reason,
            },
          ],
        };
        await this.recordRuntimeStep({
          run: input.run,
          node_name: 'runtime_stop',
          action,
          state,
          token_usage: actionResult.response.usage,
          status: stopStatus === 'cancelled' ? 'completed' : 'failed',
        });
        await saveCheckpoint({
          run_id: input.run.run_id,
          state,
          status: stopStatus,
        });
        return {
          run: await this.updateRun(input.run.run_id, stopStatus, 'stopped', state),
          state,
        };
      }
    }

    return {
      run: await this.interruptForHuman({
        run: input.run,
        actor_id: input.actor_id,
        trace_id: input.trace_id,
        phase: input.phase,
        state: {
          ...state,
          current_node: 'human_fallback',
        },
        reason: 'runtime_loop_max_turns_exceeded',
        context: {
          max_turns: input.max_turns,
        },
      }),
      state,
    };
  }

  private async callActionAgent(input: {
    run: AgentRunRow;
    agent_type: AgentType;
    messages: LlmMessage[];
  }): Promise<{
    action: AgentAction;
    response: Awaited<ReturnType<ReturnType<typeof getLlmClient>['chatCompletion']>>;
  }> {
    const model = await resolveModelForAgent(input.agent_type);
    const prompt = await findActivePromptTemplate(input.agent_type);
    const response = await getLlmClient().chatCompletion({
      model: model.model,
      messages: prompt
        ? [
          {
            role: 'system',
            content: `${prompt.content} Prompt version: ${prompt.version}. Return exactly one action JSON object.`,
          },
          ...input.messages.slice(1),
        ]
        : input.messages,
      response_format: 'json_object',
      trace_id: input.run.trace_id ?? input.run.state.trace_id,
      run_id: input.run.run_id,
      agent_type: input.agent_type,
      prompt_version: prompt?.version ?? PROMPT_VERSION,
    });
    return {
      action: validateAgentAction({
        json: response.json,
        agent_type: input.agent_type,
        model: model.model,
        trace_id: input.run.trace_id ?? input.run.state.trace_id,
      }),
      response,
    };
  }

  private async executeToolAction(input: {
    run: AgentRunRow;
    state: AgentGraphState;
    actor_id: string;
    trace_id: string;
    phase: AgentPhase;
    agent_type: AgentType;
    action: Extract<AgentAction, { action: 'call_tool' }>;
    tool_scope: {
      policy_id?: string;
      application?: ApplicationAgentContextRow;
      review?: ReviewTaskRuntimeContext;
      manual_resume?: unknown;
    };
    approval_override?: {
      approval_id: string;
    };
  }) {
    const tenant = readTenantPolicy(input.state);
    assertTenantCapabilityAllowed({
      tenant,
      tool_name: input.action.tool_name,
      plugin_id: 'core.agent-runtime',
    });
    const contract = resolveOrchestrationContract(input.state, input.phase);
    const semantic = requireToolSemanticDefinition(input.action.tool_name);
    const decision = decideToolSideEffect({
      tool_name: input.action.tool_name,
      contract,
      semantic,
    });
    if (!decision.allowed) {
      throw new ApiError('FORBIDDEN', decision.reason);
    }
    const approvedState = requireApprovalForSideEffect({
      state: input.state,
      side_effect_class: decision.approval_required
        ? 'approval_required'
        : decision.side_effect_class,
      reason: `tool ${input.action.tool_name} requires approval`,
      context: {
        tool_name: input.action.tool_name,
        semantic: decision,
      },
      contract,
    });
    if (decision.approval_required && !input.approval_override) {
      const approvalId = readLatestPendingApprovalId(approvedState);
      throw new ToolApprovalRequiredInterrupt({
        state: {
          ...approvedState,
          current_node: 'runtime_tool_approval',
          runtime: {
            ...(approvedState.runtime ?? {}),
            pending_tool_approval: {
              approval_id: approvalId,
              status: 'pending',
              action: input.action,
              phase: input.phase,
              agent_type: input.agent_type,
              tool_scope: snapshotToolScope(input.tool_scope),
              semantic_decision: decision,
              requested_at: new Date().toISOString(),
            },
            tool_semantics: {
              ...(approvedState.runtime?.tool_semantics ?? {}),
              [input.action.tool_name]: decision,
            },
          },
        },
        decision,
      });
    }
    const saga = beginSagaStep({
      state: approvedState,
      tool_name: input.action.tool_name,
      semantic: decision,
    });
    const toolInput = prepareScopedToolInput({
      tool_name: input.action.tool_name,
      tool_input: input.action.tool_input,
      tool_scope: input.tool_scope,
    });
    try {
      const result = await agentToolRunner.execute(input.action.tool_name, toolInput, {
        run_id: input.run.run_id,
        actor_id: input.actor_id,
        trace_id: input.trace_id,
        agent_type: resolveToolAgent(input.action.tool_name, input.agent_type),
        entrypoint: input.phase,
        item_id: input.tool_scope.application?.item_id ?? input.tool_scope.review?.item_id,
        roles: input.state.runtime?.actor?.roles,
        user_type: input.state.runtime?.actor?.user_type,
      });
      return {
        ...result,
        saga_state: completeSagaStep({
          state: saga.state,
          step_id: saga.step.step_id,
        }),
        semantic_decision: decision,
      };
    } catch (error) {
      const failedState = failSagaStep({
        state: saga.state,
        step_id: saga.step.step_id,
        reason: error instanceof Error ? error.message : 'tool execution failed',
      });
      const compensated = runCompensationForFailedTool({
        state: failedState,
        step_id: saga.step.step_id,
        semantic,
        error_message: error instanceof Error ? error.message : 'tool execution failed',
      });
      Object.assign(error as object, {
        saga_state: compensated.state,
        semantic_decision: decision,
        compensation: compensated,
      });
      throw error;
    }
  }

  private async interruptForToolApproval(input: {
    run: AgentRunRow;
    state: AgentGraphState;
    phase: AgentPhase;
    action: Extract<AgentAction, { action: 'call_tool' }>;
    decision: ToolSemanticDecision;
    token_usage: LlmTokenUsage | null;
  }): Promise<AgentRunRow> {
    await agentStepRecorder.recordStep({
      run_id: input.run.run_id,
      node_name: 'runtime_tool_approval',
      agent_type: input.state.runtime?.active_agent as string | undefined,
      status: 'interrupted',
      input: {
        action: input.action.action,
        phase: input.phase,
        tool_name: input.action.tool_name,
      },
      output: {
        approval_required: true,
        side_effect_class: input.decision.side_effect_class,
        semantic_class: input.decision.semantic_class,
      },
      token_usage: usageToRecord(input.token_usage),
    });
    await saveCheckpoint({
      run_id: input.run.run_id,
      state: input.state,
      status: 'interrupted',
    });
    return this.updateRun(
      input.run.run_id,
      'interrupted',
      'runtime_tool_approval',
      input.state,
    );
  }

  private async rebuildPendingToolScope(input: {
    pending: NonNullable<AgentGraphState['runtime']>['pending_tool_approval'];
    manual_resume?: unknown;
  }): Promise<{
    policy_id?: string;
    application?: ApplicationAgentContextRow;
    review?: ReviewTaskRuntimeContext;
    manual_resume?: unknown;
  }> {
    const scope = input.pending?.tool_scope ?? {};
    const policyId = normalizeString(scope.policy_id);
    const applicationId = normalizeString(scope.application_id);
    const itemId = normalizeString(scope.item_id);
    if (scope.kind === 'application' && applicationId) {
      const context = await findApplicationAgentContext(applicationId, itemId);
      if (!context) {
        throw new ApiError('NOT_FOUND', 'application not found');
      }
      return {
        application: context,
        manual_resume: input.manual_resume,
      };
    }
    if (scope.kind === 'review' && itemId) {
      const task = await findReviewTaskByItemId(itemId);
      if (!task) {
        throw new ApiError('NOT_FOUND', 'review task not found');
      }
      return {
        review: {
          item_id: task.item_id,
          application_id: task.application_id,
          enterprise_id: task.enterprise_id,
          applicant_user_id: task.applicant_user_id,
          policy_id: task.policy_id,
          policy_title: task.policy_title,
          policy_version: task.policy_version,
          policy_item_status: task.policy_item_status,
        },
        manual_resume: input.manual_resume,
      };
    }
    return {
      policy_id: policyId,
      manual_resume: input.manual_resume,
    };
  }

  private async applyPostToolApplicationGuards(input: {
    run: AgentRunRow;
    phase: AgentPhase;
    action: Extract<AgentAction, { action: 'call_tool' }>;
    state: AgentGraphState;
  }): Promise<AgentGraphState> {
    if (
      !['application', 'review'].includes(input.phase) ||
      input.action.tool_name !== 'eligibility.rule_engine.check' ||
      !input.state.eligibility
    ) {
      return input.state;
    }

    let state = await this.runRuntimeMathVerification(input.run, input.state, input.phase);
    state = await this.runRuntimeRiskJudge(input.run, state, input.phase);
    return state;
  }

  private async applyPostToolReviewDocumentVision(input: {
    run: AgentRunRow;
    phase: AgentPhase;
    action: Extract<AgentAction, { action: 'call_tool' }>;
    state: AgentGraphState;
  }): Promise<AgentGraphState> {
    if (
      input.phase !== 'review' ||
      input.action.tool_name !== 'ocr.material_evidence.read' ||
      !input.state.ocr
    ) {
      return input.state;
    }
    return this.runRuntimeDocumentVision(input.run, input.state);
  }

  private async executeSubagentDelegation(input: {
    run: AgentRunRow;
    phase: AgentPhase;
    action: Extract<AgentAction, { action: 'delegate_subagent' }>;
    state: AgentGraphState;
    tool_scope: {
      policy_id?: string;
      application?: ApplicationAgentContextRow;
      review?: ReviewTaskRuntimeContext;
      manual_resume?: unknown;
    };
    contract: OrchestrationContract;
  }): Promise<AgentGraphState> {
    const targetPhase = input.action.target_phase ?? input.phase;
    const route = buildCrossDomainRoute({
      state: input.state,
      from_phase: input.phase,
      target_phase: targetPhase,
      contract: input.contract,
      tool_scope: input.tool_scope,
    });
    const subagents = normalizeDelegatedSubagents(input.action, targetPhase);
    const tenant = readTenantPolicy(input.state);
    for (const agentType of subagents) {
      assertTenantCapabilityAllowed({
        tenant,
        agent_type: agentType,
        plugin_id: 'core.agent-runtime',
      });
    }
    const coordinationPlan = selectWorkersForGoal({
      phase: input.phase,
      target_phase: targetPhase,
      goal: readDelegationGoal(input.action.task_input),
      requested_workers: subagents,
      fanout_mode: input.contract.fanout_mode,
    });
    await this.auditCrossDomainDelegation({
      run: input.run,
      from_phase: input.phase,
      target_phase: targetPhase,
      contract: input.contract,
      subagents,
      task_input: input.action.task_input,
      route_context: route.context,
    });
    const fanout = await executeSubagentFanOut({
      phase: input.phase,
      state: {
        ...input.state,
        runtime: {
          ...(input.state.runtime ?? {}),
          orchestration_contract: input.contract,
          coordinator_registry: coordinationPlan.coordinator,
          task_graph: coordinationPlan.task_graph,
          cross_domain: {
            from_phase: input.phase,
            target_phase: targetPhase,
            mode: input.contract.mode,
            context: route.context,
            boundaries: route.boundaries,
          },
        },
      },
      subagents: coordinationPlan.selected_workers,
      task_graph: coordinationPlan.task_graph,
      task_input: input.action.task_input,
      permission_scope: route.permission_scope,
      budget: DEFAULT_SUBAGENT_BUDGET,
      contract: input.contract,
      run_subagent: async ({ agent_type: agentType, state, task_input, phase }) => {
        assertPhaseAgentAllowed({
          phase,
          agent_type: agentType,
        });
        return this.runPhaseSubagent({
          run: input.run,
          phase,
          state,
          agent_type: agentType,
          task_input,
          permission_scope: buildCrossDomainRoute({
            state,
            from_phase: input.phase,
            target_phase: phase,
            contract: input.contract,
            tool_scope: route.tool_scope,
          }).permission_scope,
        });
      },
      save_child_checkpoint: async ({
        parent_state,
        child_state,
        result,
        phase,
      }) => saveNestedRuntimeCheckpoint({
        parent_state,
        child_state,
        result,
        from_phase: input.phase,
        target_phase: phase,
      }),
    });
    const verifiedState = fanout.state;
    const arbitration = runArbitrationStrategy({
      contract: input.contract,
      signals: [
        ...fanout.results
          .filter((result) => result.agent_type !== 'risk_judge')
          .map((result) => ({
            agent_type: result.agent_type,
            confidence: readOutputConfidence(result.output),
          })),
        ...(verifiedState.judge
          ? [{
              agent_type: 'risk_judge' as const,
              approved: verifiedState.judge.approved,
              should_fallback: verifiedState.judge.should_fallback,
              confidence: verifiedState.judge.confidence,
              reasons: verifiedState.judge.reasons,
            }]
          : []),
      ],
    });
    const faninState = arbitration.decision === 'request_human'
      ? {
          ...verifiedState,
          judge: {
            ...(verifiedState.judge ?? {
              approved: false,
              should_fallback: true,
              reasons: [],
              confidence: arbitration.confidence,
            }),
            approved: false,
            should_fallback: true,
            reasons: [
              ...(verifiedState.judge?.reasons ?? []),
              ...arbitration.reasons,
            ],
            confidence: arbitration.confidence,
          },
        }
      : verifiedState;
    return aggregateSubagentResults({
      state: {
        ...faninState,
        runtime: {
          ...(faninState.runtime ?? {}),
          arbitration,
          orchestration_contract: input.contract,
          cross_domain: {
            from_phase: input.phase,
            target_phase: targetPhase,
            mode: input.contract.mode,
            context: route.context,
            boundaries: route.boundaries,
          },
        },
      },
      phase: targetPhase,
      subagents: coordinationPlan.selected_workers,
      permission_scope: route.permission_scope,
      subagent_results: fanout.results,
      artifact_writes: fanout.artifact_writes,
      verifier_output: faninState.judge
        ? verifyRiskJudgeOutput(faninState.judge)
        : null,
      budget: DEFAULT_SUBAGENT_BUDGET,
      fanout_mode: fanout.mode,
      task_graph: coordinationPlan.task_graph,
      coordinator_registry: coordinationPlan.coordinator,
    });
  }

  private async auditCrossDomainDelegation(input: {
    run: AgentRunRow;
    from_phase: AgentPhase;
    target_phase: AgentPhase;
    contract: OrchestrationContract;
    subagents: AgentType[];
    task_input: Record<string, unknown>;
    route_context?: Record<string, unknown>;
  }): Promise<void> {
    if (input.from_phase === input.target_phase) {
      return;
    }
    await auditService.write({
      actor_id: input.run.actor_id,
      action: 'agent_cross_domain.delegated',
      target_type: 'agent_run',
      target_id: input.run.run_id,
      trace_id: input.run.trace_id ?? undefined,
      detail: {
        from_phase: input.from_phase,
        target_phase: input.target_phase,
        mode: input.contract.mode,
        subagents: input.subagents,
        task_objective: readDelegationGoal(input.task_input),
        route_context: input.route_context,
        contract: input.contract.cross_domain,
        artifact_policies: input.subagents.map((agentType) => ({
          agent_type: agentType,
          ...resolveCrossDomainArtifactPolicy({
            contract: input.contract,
            from_phase: input.from_phase,
            target_phase: input.target_phase,
            artifact_key: readPrimaryArtifactKey(agentType),
          }),
        })),
      },
    });
  }

  private async runPhaseSubagent(input: {
    run: AgentRunRow;
    phase: AgentPhase;
    state: AgentGraphState;
    agent_type: AgentType;
    task_input: Record<string, unknown>;
    permission_scope: SubagentPermissionScope;
  }): Promise<{ state: AgentGraphState; output: SubagentOutput }> {
    assertSubagentPermission(input.permission_scope, input.agent_type);
    if (input.agent_type === 'retrieval_planner') {
      const output = this.runRuntimeRetrievalPlanner(input.state);
      const state: AgentGraphState = {
        ...input.state,
        current_node: 'runtime_retrieval_planner',
        retrieval: {
          query: output.query,
          citations: input.state.retrieval?.citations ?? [],
          confidence: input.state.retrieval?.confidence ?? 0,
          backend_mode: input.state.retrieval?.backend_mode ?? 'planner_only',
        },
      };
      return {
        state,
        output: verifySubagentResult({
          agent_type: input.agent_type,
          output,
        }).output,
      };
    }
    if (input.agent_type === 'policy_analysis') {
      const state = await this.runRuntimePolicyAnalysis(input.run, input.state);
      return {
        state,
        output: verifySubagentResult({
          agent_type: input.agent_type,
          output: state.policy_analysis,
        }).output,
      };
    }
    if (input.agent_type === 'document_vision') {
      const state = await this.runRuntimeDocumentVision(input.run, input.state);
      return {
        state,
        output: verifySubagentResult({
          agent_type: input.agent_type,
          output: state.document_vision,
        }).output,
      };
    }
    if (input.agent_type === 'math_verification') {
      const state = await this.runRuntimeMathVerification(input.run, input.state, input.phase);
      return {
        state,
        output: verifySubagentResult({
          agent_type: input.agent_type,
          output: state.math_verification,
        }).output,
      };
    }
    if (input.agent_type === 'risk_judge') {
      const state = await this.runRuntimeRiskJudge(input.run, input.state, input.phase);
      return {
        state,
        output: verifySubagentResult({
          agent_type: input.agent_type,
          output: state.judge,
        }).output,
      };
    }
    throw new ApiError('FORBIDDEN', `subagent ${input.agent_type} is not supported`);
  }

  private runRuntimeRetrievalPlanner(state: AgentGraphState): RetrievalPlannerOutput {
    return {
      query: typeof state.retrieval?.query === 'string'
        ? state.retrieval.query
        : readQuestion(state),
      policy_id: typeof state.input.policy_id === 'string'
        ? state.input.policy_id
        : undefined,
      limit: 3,
    };
  }

  private async runRuntimePolicyAnalysis(
    run: AgentRunRow,
    state: AgentGraphState,
  ): Promise<AgentGraphState> {
    const output = await this.callJsonAgent<PolicyAnalysisOutput>({
      run: { ...run, state },
      node_name: 'runtime_policy_analysis',
      agent_type: 'policy_analysis',
      schema: 'policy_analysis',
      input: {
        citation_count: state.retrieval?.citations.length ?? 0,
        policy_id: state.input.policy_id ?? null,
      },
      system_prompt: [
        'You analyze policy consultation evidence after retrieval.',
        'Use only retrieved citations and the user question.',
        'Never invent citations or policy conditions.',
        'Return JSON with result, explanation, matched_conditions, missing_fields, answer, confidence.',
      ].join(' '),
      user_prompt: wrapUntrustedContent('runtime_policy_analysis_input', {
        question: readQuestion(state),
        retrieval: state.retrieval ?? null,
      }),
    });
    const nextState: AgentGraphState = {
      ...state,
      current_node: 'runtime_policy_analysis',
      policy_analysis: {
        result: output.json?.result ?? 'policy_analysis_completed',
        matched_conditions: output.json?.matched_conditions ?? [],
        missing_fields: Array.isArray(output.json?.missing_fields)
          ? output.json.missing_fields.filter((item): item is string => typeof item === 'string')
          : [],
        explanation: output.json?.explanation ?? '',
        answer: output.json?.answer,
        confidence: toConfidence(output.json?.confidence),
      },
    };
    await saveCheckpoint({ run_id: run.run_id, state: nextState });
    return nextState;
  }

  private async runRuntimeDocumentVision(
    run: AgentRunRow,
    state: AgentGraphState,
  ): Promise<AgentGraphState> {
    const output = await this.callJsonAgent<DocumentVisionOutput>({
      run: { ...run, state },
      node_name: 'runtime_document_vision',
      agent_type: 'document_vision',
      schema: 'document_vision',
      input: {
        material_count: state.ocr?.materials.length ?? 0,
        low_confidence_material_ids: state.ocr?.low_confidence_material_ids ?? [],
      },
      system_prompt: [
        'You inspect submitted document summaries for review risks.',
        'Use only summary evidence. Do not ask for or infer hidden OCR fields.',
        'If no OCR summary is available, report missing evidence as a review risk.',
        'Low-confidence OCR must be listed as a risk, not hard evidence.',
        'Return JSON with risk_items, usable_as_hard_evidence, confidence.',
      ].join(' '),
      user_prompt: wrapUntrustedContent('runtime_document_vision_input', {
        ocr_summary: state.ocr?.materials ?? [],
        hard_evidence_rule:
          'Low confidence OCR must not be treated as hard evidence.',
      }),
    });
    const guardrailRisks = (state.ocr?.materials ?? [])
      .filter((material) => material.requires_manual_confirmation)
      .map((material) => ({
        field: 'ocr.low_confidence',
        severity: 'high' as const,
        reason: `OCR confidence for ${material.material_type} is below threshold; manual confirmation is required.`,
      }));
    const nextState: AgentGraphState = {
      ...state,
      current_node: 'runtime_document_vision',
      document_vision: {
        risk_items: [
          ...guardrailRisks,
          ...(Array.isArray(output.json?.risk_items) ? output.json.risk_items : []),
        ],
        usable_as_hard_evidence: guardrailRisks.length > 0
          ? false
          : output.json?.usable_as_hard_evidence ?? false,
        confidence: toConfidence(output.json?.confidence),
      },
    };
    await saveCheckpoint({ run_id: run.run_id, state: nextState });
    return nextState;
  }

  private async runRuntimeMathVerification(
    run: AgentRunRow,
    state: AgentGraphState,
    phase: AgentPhase,
  ): Promise<AgentGraphState> {
    const output = await this.callJsonAgent<MathVerificationOutput>({
      run: { ...run, state },
      node_name: 'runtime_math_verification',
      agent_type: 'math_verification',
      schema: 'math_verification',
      input: {
        numeric_conditions: extractNumericConditions(state.eligibility),
      },
      system_prompt: [
        phase === 'review'
          ? 'You explain numeric review checks.'
          : 'You explain numeric policy checks.',
        'Rules decide eligibility. Do not override rule results.',
        'Return JSON with verdict, explanation, checked_conditions, confidence.',
      ].join(' '),
      user_prompt: wrapUntrustedContent('runtime_math_verification_input', {
        eligibility: state.eligibility,
        rule_first:
          'Rules decide eligibility. Math agent only explains numeric comparisons.',
      }),
    });
    const nextState: AgentGraphState = {
      ...state,
      current_node: 'runtime_math_verification',
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

  private async runRuntimeRiskJudge(
    run: AgentRunRow,
    state: AgentGraphState,
    phase: AgentPhase,
  ): Promise<AgentGraphState> {
    const ruleLlmConflict = hasRuleLlmConflict(state);
    const output = await this.callJsonAgent<RiskJudgeOutput>({
      run: { ...run, state },
      node_name: 'runtime_risk_judge',
      agent_type: 'risk_judge',
      schema: 'risk_judge',
      input: {
        eligibility_result: state.eligibility?.result ?? null,
        math_verdict: state.math_verification?.verdict ?? null,
        rule_llm_conflict: ruleLlmConflict,
        phase,
      },
      system_prompt: [
        phase === 'review'
          ? 'You judge review draft risks.'
          : 'You judge application agent risks.',
        'Rules override LLM outputs. Return JSON with approved, should_fallback, reasons, confidence.',
      ].join(' '),
      user_prompt: wrapUntrustedContent('runtime_risk_judge_input', {
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
      current_node: 'runtime_risk_judge',
      judge: {
        approved: phase === 'review'
          ? false
          : (output.json?.approved ?? false) && !shouldFallback,
        should_fallback: shouldFallback,
        reasons: phase === 'review'
          ? [...reasons, 'no_auto_approval_review_runtime']
          : reasons,
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
  }): Promise<{
    json: TJson;
    response: Awaited<ReturnType<ReturnType<typeof getLlmClient>['chatCompletion']>>;
  }> {
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
    return { json, response };
  }

  private async completeReviewDraft(input: {
    run: AgentRunRow;
    actor_id: string;
    trace_id: string;
    state: AgentGraphState;
    action: Extract<AgentAction, { action: 'respond_final' }>;
    review: ReviewTaskRuntimeContext;
    token_usage: LlmTokenUsage | null;
  }): Promise<AgentRunRow> {
    const riskItems = [
      ...(input.state.document_vision?.risk_items ?? []),
      ...(input.state.judge?.reasons ?? []).map((reason) => ({
        field: 'risk_judge',
        severity: 'medium' as const,
        reason,
      })),
    ];
    const missingEvidence = input.state.eligibility?.missing_fields ?? [];
    const draft = await insertReviewAgentDraft({
      run_id: input.run.run_id,
      item_id: input.review.item_id,
      application_id: input.review.application_id,
      reviewer_id: input.actor_id,
      suggested_decision: inferReviewSuggestedDecision(input.state),
      opinion: input.action.answer || 'Agent draft requires manual reviewer confirmation.',
      risk_items: riskItems,
      missing_evidence: missingEvidence,
      reasoning: {
        no_auto_decision: true,
        runtime_driven: true,
        eligibility_result: input.state.eligibility?.result ?? null,
        math_explanation: input.state.math_verification?.explanation ?? null,
        judge: input.state.judge ?? null,
      },
      agent_outputs: {
        runtime: input.state.runtime ?? null,
        coordinator: input.state.runtime?.coordinator ?? null,
        subagents: input.state.runtime?.subagents ?? [],
        verifier: input.state.runtime?.verifier ?? null,
        eligibility: input.state.eligibility ?? null,
        document_vision: input.state.document_vision ?? null,
        math_verification: input.state.math_verification ?? null,
        risk_judge: input.state.judge ?? null,
        draft_review_opinion: {
          answer: input.action.answer,
          confidence: input.action.confidence,
          rationale: input.action.rationale ?? null,
        },
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
        item_id: input.review.item_id,
        application_id: input.review.application_id,
        suggested_decision: draft.suggested_decision,
        risk_count: riskItems.length,
        missing_evidence_count: missingEvidence.length,
        no_auto_decision: true,
        runtime_driven: true,
      },
    });
    const state: AgentGraphState = {
      ...input.state,
      current_node: 'runtime_review_draft',
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
    await this.recordRuntimeStep({
      run: input.run,
      node_name: 'runtime_review_draft',
      action: input.action,
      state,
      token_usage: input.token_usage,
    });
    await saveCheckpoint({
      run_id: input.run.run_id,
      state,
      status: 'completed',
    });
    return this.updateRun(input.run.run_id, 'completed', 'runtime_review_draft', state);
  }

  private async recordRuntimeStep(input: {
    run: AgentRunRow;
    node_name: string;
    action: AgentAction;
    state: AgentGraphState;
    token_usage: LlmTokenUsage | null;
    tool_calls?: unknown[];
    status?: 'completed' | 'failed';
  }) {
    await agentStepRecorder.recordStep({
      run_id: input.run.run_id,
      node_name: input.node_name,
      agent_type: input.state.runtime?.active_agent as string | undefined,
      status: input.status ?? 'completed',
      input: {
        action: input.action.action,
        phase: input.state.runtime?.phase ?? input.run.entrypoint,
        turn_count: input.state.runtime?.turn_count ?? null,
      },
      output: summarizeActionOutput(input.action, input.state),
      token_usage: usageToRecord(input.token_usage),
      tool_calls: input.tool_calls,
    });
  }

  private async interruptForHuman(input: {
    run: AgentRunRow;
    actor_id: string;
    trace_id: string;
    phase: AgentPhase;
    state: AgentGraphState;
    reason: string;
    context?: Record<string, unknown>;
  }): Promise<AgentRunRow> {
    if (input.phase === 'application') {
      return this.interruptApplicationForHuman(input);
    }
    const approvalState = applyHumanInterruptApproval({
      phase: input.phase,
      state: input.state,
      reason: input.reason,
      context: input.context,
    });
    const question = readQuestion(input.state);
    const fallback = await fallbackService.createIfNotExists({
      actor_id: input.actor_id,
      trace_id: input.trace_id,
      source_type: 'agent_run',
      source_id: input.run.run_id,
      run_id: input.run.run_id,
      reason: input.reason,
      context: {
        run_id: input.run.run_id,
        normalized_question: normalizeQuestion(question),
        policy_id: typeof approvalState.input.policy_id === 'string'
          ? approvalState.input.policy_id
          : null,
        citation_count: approvalState.retrieval?.citations.length ?? 0,
        ...(input.context ?? {}),
      },
    });
    await attachFallbackTaskToRun({
      task_id: fallback.task.task_id,
      run_id: input.run.run_id,
    });
    const state: AgentGraphState = {
      ...approvalState,
      current_node: 'human_fallback',
      fallback: {
        task_id: fallback.task.task_id,
        reason: input.reason,
      },
      final: {
        status: 'manual_review',
        answer: 'No usable policy citation was found. Manual fallback is required.',
        citations: approvalState.retrieval?.citations ?? [],
        next_actions: ['manual_fallback'],
      },
    };
    await agentStepRecorder.recordStep({
      run_id: input.run.run_id,
      node_name: 'runtime_request_human',
      agent_type: input.state.runtime?.active_agent as string | undefined,
      status: 'interrupted',
      input: {
        reason: input.reason,
      },
      output: {
        fallback_task_id: fallback.task.task_id,
      },
    });
    await saveCheckpoint({
      run_id: input.run.run_id,
      state,
      status: 'interrupted',
    });
    return this.updateRun(input.run.run_id, 'interrupted', 'human_fallback', state);
  }

  private async interruptApplicationForHuman(input: {
    run: AgentRunRow;
    actor_id: string;
    trace_id: string;
    state: AgentGraphState;
    reason: string;
    context?: Record<string, unknown>;
  }): Promise<AgentRunRow> {
    const approvalState = applyHumanInterruptApproval({
      phase: 'application',
      state: input.state,
      reason: input.reason,
      context: input.context,
    });
    const applicationId = readApplicationId(approvalState);
    const fallback = await fallbackService.createIfNotExists({
      actor_id: input.actor_id,
      trace_id: input.trace_id,
      source_type: 'agent_run',
      source_id: input.run.run_id,
      run_id: input.run.run_id,
      reason: input.reason,
      context: {
        run_id: input.run.run_id,
        application_id: applicationId,
        normalized_application_id: normalizeQuestion(applicationId),
        eligibility_result: approvalState.eligibility?.result ?? null,
        judge: approvalState.judge ?? null,
        document_vision: approvalState.document_vision ?? null,
        ocr: summarizeOcrForFallback(approvalState.ocr),
        ...(input.context ?? {}),
      },
    });
    await attachFallbackTaskToRun({
      task_id: fallback.task.task_id,
      run_id: input.run.run_id,
    });
    const state: AgentGraphState = {
      ...approvalState,
      current_node: 'human_fallback',
      fallback: {
        task_id: fallback.task.task_id,
        reason: input.reason,
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
      node_name: 'runtime_request_human',
      agent_type: input.state.runtime?.active_agent as string | undefined,
      status: 'interrupted',
      input: {
        reason: input.reason,
      },
      output: {
        fallback_task_id: fallback.task.task_id,
      },
    });
    await saveCheckpoint({
      run_id: input.run.run_id,
      state,
      status: 'interrupted',
    });
    return this.updateRun(input.run.run_id, 'interrupted', 'human_fallback', state);
  }

  private async updateRun(
    runId: string,
    status: AgentRunStatus,
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

function resolveToolAgent(
  toolName: AgentToolName,
  fallbackAgent: AgentType,
): AgentType {
  if (toolName === 'rag.search') {
    return 'retrieval_planner';
  }
  if (toolName === 'ocr.material_evidence.read') {
    return 'document_vision';
  }
  if (toolName === 'eligibility.rule_engine.check') {
    if (fallbackAgent === 'review') {
      return 'review';
    }
    return 'application_assist';
  }
  return fallbackAgent;
}

function prepareScopedToolInput(input: {
  tool_name: AgentToolName;
  tool_input: Record<string, unknown>;
  tool_scope: {
    policy_id?: string;
    application?: ApplicationAgentContextRow;
    review?: ReviewTaskRuntimeContext;
    manual_resume?: unknown;
  };
}): Record<string, unknown> {
  if (input.tool_name === 'rag.search') {
    return {
      query: typeof input.tool_input.query === 'string' ? input.tool_input.query : '',
      policy_id: input.tool_scope.policy_id,
      limit: 3,
      create_fallback_task: false,
    };
  }
  if (input.tool_name === 'ocr.material_evidence.read') {
    const application = input.tool_scope.application ?? input.tool_scope.review;
    if (!application) {
      throw new ApiError('VALIDATION_ERROR', 'application or review tool scope is required');
    }
    return {
      application_id: application.application_id,
      confirmed_materials: readConfirmedMaterials(input.tool_scope.manual_resume),
      mode: input.tool_scope.review ? 'summary' : 'full',
    };
  }
  if (input.tool_name === 'eligibility.rule_engine.check') {
    const application = input.tool_scope.application ?? input.tool_scope.review;
    if (!application) {
      throw new ApiError('VALIDATION_ERROR', 'application or review tool scope is required');
    }
    return {
      application_id: application.application_id,
      item_id: application.item_id,
      enterprise_id: application.enterprise_id,
      applicant_user_id: application.applicant_user_id,
      policy_id: application.policy_id,
      confirmed_materials: readConfirmedMaterials(input.tool_scope.manual_resume),
    };
  }
  return input.tool_input;
}

function mergeToolResultState(
  state: AgentGraphState,
  toolName: AgentToolName,
  output: unknown,
  phase: AgentPhase,
): AgentGraphState {
  if (toolName === 'rag.search') {
    const result = readRagSearchToolOutput(output);
    return {
      ...state,
      current_node: 'runtime_call_tool',
      retrieval: {
        query: typeof state.input.question === 'string' ? state.input.question : '',
        citations: result?.citations ?? [],
        confidence: result?.confidence ?? 0,
        backend_mode: result?.backend_mode ?? 'local_fallback',
      },
    };
  }
  if (toolName === 'ocr.material_evidence.read') {
    const result = readMaterialEvidenceOutput(output);
    if (!result) {
      return state;
    }
    const nextState: AgentGraphState = {
      ...state,
      current_node: 'runtime_call_tool',
      ocr: {
        materials: result.materials,
        low_confidence_material_ids: result.low_confidence_material_ids,
        hard_evidence_notice: result.hard_evidence_notice,
      },
    };
    if (phase === 'review') {
      return nextState;
    }
    const lowConfidenceMaterials = result.materials.filter(
      (material) => !material.hard_evidence_allowed,
    );
    return {
      ...nextState,
      document_vision: {
        risk_items: lowConfidenceMaterials.map((material) => ({
          field: 'ocr.low_confidence',
          severity: 'high' as const,
          reason: `OCR confidence for ${material.material_type} is below threshold; manual confirmation is required.`,
        })),
        usable_as_hard_evidence: lowConfidenceMaterials.length === 0,
        confidence: lowConfidenceMaterials.length === 0 ? 0.9 : 0.7,
      },
    };
  }
  if (toolName === 'eligibility.rule_engine.check') {
    const result = readEligibilityOutput(output);
    if (!result) {
      return state;
    }
    const guardrailReasons = guardrailJudgeReasons({
      ...state,
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
    }, false);
    const shouldFallback =
      guardrailReasons.length > 0 ||
      result.result === 'manual_review';
    return {
      ...state,
      current_node: 'runtime_call_tool',
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
      judge: {
        approved: result.result === 'eligible' && !shouldFallback,
        should_fallback: shouldFallback,
        reasons: guardrailReasons,
        confidence: shouldFallback ? 0.7 : 0.85,
      },
    };
  }
  return state;
}

function readRagSearchToolOutput(output: unknown): RagSearchResult | null {
  if (!output || typeof output !== 'object') {
    return null;
  }
  const value = output as Partial<RagSearchResult>;
  if (!Array.isArray(value.citations)) {
    return null;
  }
  return {
    status: value.status ?? 'no_match',
    citations: value.citations,
    confidence: typeof value.confidence === 'number' ? value.confidence : 0,
    backend_mode: value.backend_mode ?? 'local_fallback',
    fallback_task: value.fallback_task ?? null,
    degrade_reason: value.degrade_reason ?? null,
  };
}

function readMaterialEvidenceOutput(output: unknown): MaterialEvidenceReadToolOutput | null {
  if (!output || typeof output !== 'object') {
    return null;
  }
  const value = output as Partial<MaterialEvidenceReadToolOutput>;
  if (!Array.isArray(value.materials)) {
    return null;
  }
  return {
    materials: value.materials,
    low_confidence_material_ids: Array.isArray(value.low_confidence_material_ids)
      ? value.low_confidence_material_ids
      : [],
    hard_evidence_notice: typeof value.hard_evidence_notice === 'string'
      ? value.hard_evidence_notice
      : 'Low confidence OCR is visible to agents but cannot satisfy hard eligibility rules.',
  };
}

function readEligibilityOutput(output: unknown): EligibilitySingleResult | null {
  if (!output || typeof output !== 'object') {
    return null;
  }
  const value = output as Partial<EligibilitySingleResult>;
  if (typeof value.result !== 'string') {
    return null;
  }
  return {
    policy_id: typeof value.policy_id === 'string' ? value.policy_id : '',
    result: value.result,
    matched_conditions: Array.isArray(value.matched_conditions) ? value.matched_conditions : [],
    failed_conditions: Array.isArray(value.failed_conditions) ? value.failed_conditions : [],
    missing_fields: Array.isArray(value.missing_fields) ? value.missing_fields : [],
    citations: Array.isArray(value.citations) ? value.citations : [],
    evidence_refs: Array.isArray(value.evidence_refs) ? value.evidence_refs : [],
    fallback_task: value.fallback_task ?? null,
    ai_summary: typeof value.ai_summary === 'string' ? value.ai_summary : '',
    evidence_priority_notice: typeof value.evidence_priority_notice === 'string'
      ? value.evidence_priority_notice
      : '',
    rule_first_notice: typeof value.rule_first_notice === 'string'
      ? value.rule_first_notice
      : '',
  };
}

function appendActionObservation(
  messages: LlmMessage[],
  action: AgentAction,
  observation: unknown,
): LlmMessage[] {
  return [
    ...messages,
    {
      role: 'assistant',
      content: JSON.stringify(action),
    },
    {
      role: 'user',
      content: wrapUntrustedContent('runtime_observation', observation),
    },
  ];
}

function summarizeActionOutput(
  action: AgentAction,
  state: AgentGraphState,
): Record<string, unknown> {
  if (action.action === 'call_tool') {
    return {
      tool_name: action.tool_name,
      citation_count: state.retrieval?.citations.length ?? null,
      confidence: state.retrieval?.confidence ?? null,
      material_count: state.ocr?.materials.length ?? null,
      eligibility_result: state.eligibility?.result ?? null,
    };
  }
  if (action.action === 'respond_final') {
    return {
      confidence: action.confidence,
      citation_count: action.citations?.length ?? state.retrieval?.citations.length ?? 0,
    };
  }
  return { ...action };
}

function buildFinalState(
  state: AgentGraphState,
  action: Extract<AgentAction, { action: 'respond_final' }>,
  phase: AgentPhase,
): AgentGraphState {
  if (phase === 'application') {
    return {
      ...state,
      current_node: 'final',
      judge: state.judge ?? {
        approved: false,
        should_fallback: false,
        reasons: [],
        confidence: action.confidence,
      },
      final: {
        status: 'application_agent_completed',
        answer: action.answer || 'Application agent run completed. Eligibility remains rule-engine first.',
        next_actions: [],
      },
    };
  }
  return {
    ...state,
    current_node: 'final',
    judge: {
      approved: action.confidence >= 0.75,
      should_fallback: false,
      reasons: [],
      confidence: action.confidence,
    },
    final: {
      status: 'answered',
      answer: buildFinalAnswer({
        answer: action.answer,
        citations: action.citations ?? state.retrieval?.citations ?? [],
      }),
      citations: action.citations ?? state.retrieval?.citations ?? [],
      next_actions: [],
    },
  };
}

function buildFinalAnswer(input: {
  answer: string;
  citations: unknown[];
}): string {
  const firstCitation = input.citations[0] as Partial<RagCitation> | undefined;
  if (!firstCitation) {
    return input.answer;
  }
  const citationLabel = `${firstCitation.title ?? 'policy'} ${firstCitation.version ?? ''}`.trim();
  if (input.answer.includes('Citation:')) {
    return input.answer;
  }
  return `${input.answer}\n\nCitation: ${citationLabel}`;
}

function withRuntimeTurn(
  state: AgentGraphState,
  runtime: {
    phase: AgentPhase;
    active_agent: AgentType;
    turn_count: number;
  },
): AgentGraphState {
  return {
    ...state,
    runtime: {
      ...(state.runtime ?? {}),
      ...runtime,
    },
  };
}

function readQuestion(state: AgentGraphState): string {
  const question = state.input.question;
  if (typeof question !== 'string' || question.trim() === '') {
    throw new ApiError('VALIDATION_ERROR', 'question is required');
  }
  return question.trim();
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

function readItemId(state: AgentGraphState): string {
  const itemId = state.input.item_id;
  if (typeof itemId !== 'string' || itemId.trim() === '') {
    throw new ApiError('VALIDATION_ERROR', 'item_id is required');
  }
  return itemId.trim();
}

function requireApplicationToolScope(input: {
  application?: ApplicationAgentContextRow;
}): ApplicationAgentContextRow {
  if (!input.application) {
    throw new ApiError('VALIDATION_ERROR', 'application tool scope is required');
  }
  return input.application;
}

function requireReviewToolScope(input: {
  review?: ReviewTaskRuntimeContext;
}): ReviewTaskRuntimeContext {
  if (!input.review) {
    throw new ApiError('VALIDATION_ERROR', 'review tool scope is required');
  }
  return input.review;
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

function normalizeReviewResumePayload(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return {
    resume_contract_version: 'review.runtime.v1',
    confirmed_materials: Array.isArray(payload.confirmed_materials)
      ? payload.confirmed_materials.filter((item) => typeof item === 'string')
      : [],
    reviewer_notes: typeof payload.reviewer_notes === 'string'
      ? payload.reviewer_notes
      : '',
  };
}

function getApplicationGuardrailInterrupt(
  phase: AgentPhase,
  state: AgentGraphState,
): { reason: string; context: Record<string, unknown> } | null {
  if (phase !== 'application') {
    return null;
  }
  if (!state.eligibility) {
    return null;
  }
  if (state.judge?.should_fallback || state.eligibility.result === 'manual_review') {
    return {
      reason: 'application_agent_risk_fallback',
      context: {
        eligibility_result: state.eligibility.result,
        judge: state.judge ?? null,
      },
    };
  }
  return null;
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

function getFinalGateInterrupt(
  phase: AgentPhase,
  state: AgentGraphState,
): { reason: string; context: Record<string, unknown> } | null {
  if (phase !== 'application') {
    return null;
  }
  const missing: string[] = [];
  if (!state.ocr) {
    missing.push('ocr');
  }
  if (!state.document_vision) {
    missing.push('document_vision');
  }
  if (!state.eligibility) {
    missing.push('eligibility');
  }
  if (!state.math_verification) {
    missing.push('math_verification');
  }
  if (!state.judge) {
    missing.push('judge');
  }
  if (missing.length > 0) {
    return {
      reason: 'application_runtime_missing_required_artifacts',
      context: { missing_artifacts: missing },
    };
  }
  const judge = state.judge;
  const eligibility = state.eligibility;
  if (!judge || !eligibility) {
    return {
      reason: 'application_runtime_missing_required_artifacts',
      context: { missing_artifacts: ['eligibility', 'judge'] },
    };
  }
  if (judge.should_fallback || !judge.approved) {
    return {
      reason: 'application_agent_risk_fallback',
      context: {
        eligibility_result: eligibility.result,
        judge,
      },
    };
  }
  return null;
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

function toConfidence(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

function inferReviewSuggestedDecision(state: AgentGraphState): string {
  if ((state.eligibility?.missing_fields.length ?? 0) > 0) {
    return 'request_supplement';
  }
  if ((state.document_vision?.risk_items.length ?? 0) > 0 || state.judge?.should_fallback) {
    return 'manual_review';
  }
  if (state.eligibility?.result === 'ineligible') {
    return 'reject';
  }
  if (state.eligibility?.result === 'eligible') {
    return 'approve';
  }
  return 'manual_review';
}

function summarizeOcrForFallback(
  ocr: AgentGraphState['ocr'],
): Record<string, unknown> | null {
  if (!ocr) {
    return null;
  }
  return {
    material_count: ocr.materials.length,
    low_confidence_material_ids: ocr.low_confidence_material_ids,
    hard_evidence_notice: ocr.hard_evidence_notice,
  };
}

function readMaxTurns(state: AgentGraphState): number {
  const configured = state.runtime?.max_turns;
  return typeof configured === 'number' && Number.isInteger(configured) && configured > 0
    ? configured
    : DEFAULT_MAX_TURNS;
}

function readDelegationGoal(taskInput: Record<string, unknown>): string {
  const objective = taskInput.objective;
  if (typeof objective === 'string' && objective.trim() !== '') {
    return objective.trim();
  }
  const goal = taskInput.goal;
  if (typeof goal === 'string' && goal.trim() !== '') {
    return goal.trim();
  }
  return 'delegate_subagent';
}

function readFanoutMode(state: AgentGraphState): 'sequential' | 'parallel' {
  const runtime = state.runtime as Record<string, unknown> | undefined;
  if (runtime?.fanout_mode === 'parallel') {
    return 'parallel';
  }
  const contract = runtime?.orchestration_contract;
  if (
    contract &&
    typeof contract === 'object' &&
    !Array.isArray(contract) &&
    (contract as Record<string, unknown>).fanout_mode === 'parallel'
  ) {
    return 'parallel';
  }
  return 'sequential';
}

function resolveOrchestrationContract(
  state: AgentGraphState,
  phase: AgentPhase,
): OrchestrationContract {
  const runtime = state.runtime as Record<string, unknown> | undefined;
  const existing = runtime?.orchestration_contract;
  if (
    existing &&
    typeof existing === 'object' &&
    !Array.isArray(existing) &&
    (existing as Record<string, unknown>).version === 'orchestration.v1'
  ) {
    return existing as OrchestrationContract;
  }
  return buildDefaultOrchestrationContract({
    phase,
    fanout_mode: readFanoutMode(state),
  });
}

function readTenantPolicy(state: AgentGraphState) {
  const runtime = state.input.runtime;
  if (!isRecord(runtime) || !isRecord(runtime.tenant_policy)) {
    return buildTenantPolicy();
  }
  const policy = runtime.tenant_policy;
  return buildTenantPolicy({
    tenant_id: normalizeString(policy.tenant_id) ?? undefined,
    allowed_agents: Array.isArray(policy.allowed_agents)
      ? policy.allowed_agents.filter((item): item is never => typeof item === 'string')
      : undefined,
    allowed_tools: Array.isArray(policy.allowed_tools)
      ? policy.allowed_tools.filter((item): item is never => typeof item === 'string')
      : undefined,
    plugin_allowlist: Array.isArray(policy.plugin_allowlist)
      ? policy.plugin_allowlist.filter((item): item is string => typeof item === 'string')
      : undefined,
    max_parallel_subagents: typeof policy.max_parallel_subagents === 'number'
      ? policy.max_parallel_subagents
      : undefined,
  });
}

function readPendingToolApproval(
  state: AgentGraphState,
): NonNullable<AgentGraphState['runtime']>['pending_tool_approval'] | undefined {
  const pending = state.runtime?.pending_tool_approval;
  if (!pending || pending.status === 'completed') {
    return undefined;
  }
  return pending;
}

function readApprovalRequest(
  state: AgentGraphState,
  approvalId: string,
): Record<string, unknown> | undefined {
  const control = state.control;
  if (!control || typeof control !== 'object' || Array.isArray(control)) {
    return undefined;
  }
  const approvals = (control as { approval_requests?: unknown }).approval_requests;
  if (!Array.isArray(approvals)) {
    return undefined;
  }
  return approvals.find((approval): approval is Record<string, unknown> => (
    Boolean(
      approval &&
      typeof approval === 'object' &&
      !Array.isArray(approval) &&
      (approval as { approval_id?: unknown }).approval_id === approvalId,
    )
  ));
}

function readLatestPendingApprovalId(state: AgentGraphState): string {
  const control = state.control;
  const approvals = control && typeof control === 'object' && !Array.isArray(control)
    ? (control as { approval_requests?: unknown }).approval_requests
    : undefined;
  if (!Array.isArray(approvals)) {
    throw new ApiError('INTERNAL_ERROR', 'approval request was not created');
  }
  for (let index = approvals.length - 1; index >= 0; index -= 1) {
    const approval = approvals[index];
    if (
      approval &&
      typeof approval === 'object' &&
      !Array.isArray(approval) &&
      typeof (approval as { approval_id?: unknown }).approval_id === 'string' &&
      (approval as { status?: unknown }).status === 'pending'
    ) {
      return (approval as { approval_id: string }).approval_id;
    }
  }
  throw new ApiError('INTERNAL_ERROR', 'pending approval request was not created');
}

function snapshotToolScope(input: {
  policy_id?: string;
  application?: ApplicationAgentContextRow;
  review?: ReviewTaskRuntimeContext;
}): Record<string, unknown> {
  if (input.review) {
    return {
      kind: 'review',
      item_id: input.review.item_id,
      application_id: input.review.application_id,
      policy_id: input.review.policy_id,
    };
  }
  if (input.application) {
    return {
      kind: 'application',
      application_id: input.application.application_id,
      item_id: input.application.item_id,
      policy_id: input.application.policy_id,
    };
  }
  return {
    kind: 'consultation',
    policy_id: input.policy_id,
  };
}

function toPendingToolAction(
  action: NonNullable<NonNullable<AgentGraphState['runtime']>['pending_tool_approval']>['action'],
): Extract<AgentAction, { action: 'call_tool' }> {
  const toolName = action.tool_name;
  if (
    toolName !== 'rag.search' &&
    toolName !== 'ocr.material_evidence.read' &&
    toolName !== 'eligibility.rule_engine.check'
  ) {
    throw new ApiError('VALIDATION_ERROR', 'pending tool approval has invalid tool_name');
  }
  return {
    action: 'call_tool',
    tool_name: toolName,
    tool_input: action.tool_input,
    rationale: action.rationale,
  };
}

function toAgentType(value: string): AgentType {
  if (
    value === 'supervisor' ||
    value === 'retrieval_planner' ||
    value === 'policy_analysis' ||
    value === 'application_assist' ||
    value === 'document_vision' ||
    value === 'math_verification' ||
    value === 'risk_judge' ||
    value === 'review'
  ) {
    return value;
  }
  throw new ApiError('VALIDATION_ERROR', 'pending tool approval has invalid agent_type');
}

function toAgentPhase(value: string): AgentPhase {
  if (value === 'consultation' || value === 'application' || value === 'review') {
    return value;
  }
  throw new ApiError('VALIDATION_ERROR', 'pending tool approval has invalid phase');
}

function normalizeString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function applyApprovalResume(inputState: AgentGraphState, input: {
  actor_id: string;
  resume_payload: Record<string, unknown>;
}): AgentGraphState {
  const approvalId = input.resume_payload.approval_id;
  const approvalStatus = input.resume_payload.approval_status;
  if (typeof approvalId !== 'string') {
    return inputState;
  }
  return resumeAfterApproval({
    state: inputState,
    decision: {
      approval_id: approvalId,
      status: approvalStatus === 'rejected' ? 'rejected' : 'approved',
      decided_by: input.actor_id,
      decided_at: new Date().toISOString(),
      comment: typeof input.resume_payload.approval_comment === 'string'
        ? input.resume_payload.approval_comment
        : undefined,
    },
  });
}

function applyHumanInterruptApproval(input: {
  phase: AgentPhase;
  state: AgentGraphState;
  reason: string;
  context?: Record<string, unknown>;
}): AgentGraphState {
  const contract = resolveOrchestrationContract(input.state, input.phase);
  return requireApprovalForSideEffect({
    state: input.state,
    side_effect_class: classifyRuntimeSideEffect({
      action: 'request_human',
    }),
    reason: input.reason,
    context: input.context,
    contract,
  });
}

function readOutputConfidence(output: SubagentOutput | null): number {
  if (!output || typeof output !== 'object') {
    return 0;
  }
  const confidence = (output as Record<string, unknown>).confidence;
  return typeof confidence === 'number' ? toConfidence(confidence) : 0.8;
}

function readPrimaryArtifactKey(agentType: AgentType): ArtifactKey {
  const writes = getArtifactWritesForAgent(agentType);
  if (writes[0]) {
    return writes[0];
  }
  const definition = getSubagentDefinition(agentType);
  if (definition.output_contract === 'risk_verifier_result') {
    return 'judge';
  }
  return 'retrieval';
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function readErrorRecord(error: unknown): Record<string, unknown> {
  return error && typeof error === 'object' && !Array.isArray(error)
    ? error as Record<string, unknown>
    : {};
}

function isAgentGraphState(value: unknown): value is AgentGraphState {
  return Boolean(
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof (value as AgentGraphState).run_id === 'string' &&
    Array.isArray((value as AgentGraphState).errors),
  );
}

class ToolApprovalRequiredInterrupt extends Error {
  readonly state: AgentGraphState;
  readonly decision: ToolSemanticDecision;

  constructor(input: {
    state: AgentGraphState;
    decision: ToolSemanticDecision;
  }) {
    super('tool approval required');
    this.name = 'ToolApprovalRequiredInterrupt';
    this.state = input.state;
    this.decision = input.decision;
  }
}

export const agentRuntimeLoop = new AgentRuntimeLoop();
