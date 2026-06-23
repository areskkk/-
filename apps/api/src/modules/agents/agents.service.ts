import { ApiError } from '../../common/errors/http-error.js';
import { loadEnv } from '../../config/env.js';
import {
  completeResumeRequest,
  createRunJob,
  createRun,
  createQueuedResumeJob,
  createQueuedRunWithJob,
  createResumeRequest,
  failResumeRequest,
  findRunById,
  findRunByScopedIdempotencyKey,
  findResumeRequest,
  listStepsByRunId,
  listToolCallsByRunId,
  updateRunState,
  updateRunStateIfLeased,
} from './agents.repository.js';
import { findFallbackTaskByRun } from '../fallback/fallback.repository.js';
import {
  type AgentGraphState,
  type AgentRunRow,
  type AgentRunEntrypoint,
  type CreateAgentRunRequest,
  type ResumeAgentRunRequest,
} from './agents.types.js';
import {
  assertCanReadAgentRun,
  assertCanResumeAgentRun,
  assertCanStartAgentRun,
  type AgentActorContext,
} from './agents-permission.js';
import {
  getLatestCheckpoint,
  saveCheckpoint,
} from './runtime/checkpoint.repository.js';
import {
  buildNestedRuntimeResumeState,
  getNestedRuntimeCheckpointByResumeToken,
} from './runtime/nested-runtime-checkpoint.js';
import { resumeNestedAgentRuntime } from './runtime/nested-agent-runtime.js';
import {
  buildDefaultOrchestrationContract,
} from './runtime/orchestration-governance.js';
import {
  applicationGraphRunner,
} from './runtime/application-graph-runner.js';
import { agentStepRecorder } from './runtime/step-recorder.js';
import {
  consultationGraphRunner,
} from './runtime/consultation-graph-runner.js';
import { agentRuntimeLoop } from './runtime/agent-runtime-loop.js';
import {
  reviewGraphRunner,
} from './runtime/review-graph-runner.js';
import {
  isMockEntrypoint,
  mockGraphRunner,
} from './runtime/mock-graph-runner.js';
import {
  assertCanCreateAgentRun,
  attachRunQuotaReservation,
  releaseRunQuotaReservation,
  assertRunBudgetAvailable,
} from './runtime/agent-runtime-controls.js';
import {
  attachReplayRun,
  assertAgentKillSwitchOpen,
  createReplayRecord,
  markReplayFailed,
} from './runtime/agent-ops-control.js';
import {
  assertReplayTraceDeterministic,
  buildActionReplayTrace,
} from './runtime/platform-observability.js';
import { resumeWorkflowWaitByToken } from './runtime/workflow-waits.repository.js';
import { auditService } from '../audit/audit.service.js';
import crypto from 'node:crypto';

const ENTRYPOINTS = new Set<AgentRunEntrypoint>([
  'consultation',
  'application',
  'review',
  'mock_completed',
  'mock_failed',
  'mock_interrupted',
]);

export class AgentRunService {
  async startRun(input: {
    actor: AgentActorContext;
    trace_id: string;
    body: CreateAgentRunRequest;
  }) {
    const entrypoint = this.assertEntrypoint(input.body.entrypoint);
    if (
      !isMockEntrypoint(entrypoint) &&
      entrypoint !== 'consultation' &&
      entrypoint !== 'application' &&
      entrypoint !== 'review'
    ) {
      throw new ApiError(
        'VALIDATION_ERROR',
        'unsupported agent run entrypoint',
      );
    }

    const bodyInput = input.body.input ?? {};
    await assertAgentKillSwitchOpen({
      scope: 'run_creation',
    });
    await assertCanStartAgentRun({
      actor: input.actor,
      entrypoint,
      bodyInput,
      production: loadEnv().nodeEnv === 'production',
    });

    const existing = await this.findExistingIdempotentRun({
      actor_id: input.actor.actor_id,
      entrypoint,
      idempotency_key: normalizeOptionalString(input.body.idempotency_key),
      bodyInput,
    });
    if (existing) {
      return loadEnv().agentRunAsyncEnabled ? withPollUrl(existing) : existing;
    }

    const quota = await assertCanCreateAgentRun({
      actor_id: input.actor.actor_id,
      entrypoint,
      body_input: bodyInput,
      reserve: !loadEnv().agentRunAsyncEnabled,
    });

    const initialState: AgentGraphState = {
      run_id: 'pending',
      trace_id: input.trace_id,
      actor_id: input.actor.actor_id,
      entrypoint,
      input: bodyInput,
      errors: [],
      runtime: {
        queued_at: new Date().toISOString(),
        fanout_mode: readRequestedFanoutMode(bodyInput),
        orchestration_contract: buildDefaultOrchestrationContract({
          phase: entrypoint,
          mode: readRequestedOrchestrationMode(input.body),
          fanout_mode: readRequestedFanoutMode(bodyInput),
        }),
        actor: {
          roles: input.actor.roles,
          user_type: input.actor.user_type,
        },
        budget: {
          max_run_tokens: loadEnv().agentMaxRunTokens,
          max_run_cost_cents: loadEnv().agentMaxRunCostCents,
          used_tokens: 0,
          estimated_cost_cents: 0,
        },
      },
    };

    if (loadEnv().agentRunAsyncEnabled) {
      const queued = await this.createQueuedRunSafely({
          actor_id: input.actor.actor_id,
          entrypoint,
          trace_id: input.trace_id,
          state: initialState,
          idempotency_key: normalizeOptionalString(input.body.idempotency_key),
          job_payload: {
            actor_id: input.actor.actor_id,
            trace_id: input.trace_id,
            payload_hash: hashPayload(bodyInput),
          },
          enterprise_id: quota.enterprise_id,
          max_concurrent_per_user: loadEnv().agentMaxConcurrentRunsPerUser,
          max_concurrent_global: loadEnv().agentMaxConcurrentRunsGlobal,
        });
      await this.auditRunLifecycle('agent_run.queued', queued, input.actor.actor_id, {
        enterprise_id: quota.enterprise_id ?? null,
      });
      return withPollUrl(queued);
    }

    const run = await createRun({
      actor_id: input.actor.actor_id,
      entrypoint,
      trace_id: input.trace_id,
      state: initialState,
      idempotency_key: normalizeOptionalString(input.body.idempotency_key),
      status: 'running',
    });
    await attachRunQuotaReservation({
      actor_id: input.actor.actor_id,
      run_id: run.run_id,
    });
    await this.auditRunLifecycle('agent_run.started', run, input.actor.actor_id, {
      enterprise_id: quota.enterprise_id ?? null,
    });
    const state = {
      ...run.state,
      run_id: run.run_id,
    };

    const initialized = await updateRunState({
      run_id: run.run_id,
      status: 'running',
      current_node: 'mock_init',
      state,
    });
    if (!initialized) {
      throw new ApiError('NOT_FOUND', 'agent run not found');
    }

    try {
      return await this.dispatchRun({
        run: initialized,
        actor_id: input.actor.actor_id,
        trace_id: input.trace_id,
      });
    } catch (error) {
      await this.markRunFailed(initialized, error);
      throw error;
    }
  }

  async dispatchRun(input: {
    run: AgentRunRow;
    actor_id: string;
    trace_id: string;
  }) {
    await assertAgentKillSwitchOpen({
      scope: 'run_creation',
      run_id: input.run.run_id,
    });
    await assertRunBudgetAvailable(input.run);
    const entrypoint = input.run.entrypoint;
    const running = await updateRunStateIfLeased({
      run_id: input.run.run_id,
      status: 'running',
      current_node: input.run.current_node === 'queued'
        ? input.run.entrypoint
        : input.run.current_node,
      state: {
        ...input.run.state,
        runtime: {
          ...(input.run.state.runtime ?? {}),
          worker_id: input.run.state.runtime?.worker_id ?? loadEnv().agentRunWorkerId,
          job_id: input.run.state.runtime?.job_id,
          started_at: new Date().toISOString(),
        },
      },
      job_id: input.run.state.runtime?.job_id,
      worker_id: input.run.state.runtime?.worker_id,
    });
    if (!running && input.run.state.runtime?.job_id) {
      throw new Error('agent run worker lease lost before start');
    }
    const run = running ?? input.run;

    if (entrypoint === 'consultation') {
      return this.finalizeDispatchedRun(await consultationGraphRunner.run({
        run,
        actor_id: input.actor_id,
        trace_id: input.trace_id,
      }));
    }

    if (entrypoint === 'application') {
      return this.finalizeDispatchedRun(await applicationGraphRunner.run({
        run,
        actor_id: input.actor_id,
        trace_id: input.trace_id,
      }));
    }

    if (entrypoint === 'review') {
      return this.finalizeDispatchedRun(await reviewGraphRunner.run({
        run,
        actor_id: input.actor_id,
        trace_id: input.trace_id,
      }));
    }

    return this.finalizeDispatchedRun(await mockGraphRunner.run({
      run,
      actor_id: input.actor_id,
      trace_id: input.trace_id,
    }));
  }

  async getRun(runId: string, actor?: AgentActorContext) {
    const run = await findRunById(runId);
    if (!run) {
      throw new ApiError('NOT_FOUND', 'agent run not found');
    }
    if (actor) {
      await assertCanReadAgentRun({ actor, run });
      await this.auditRunLifecycle('agent_run.read', run, actor.actor_id);
    }
    return run;
  }

  async listSteps(runId: string, actor?: AgentActorContext) {
    const run = await this.getRun(runId, actor);
    if (actor) {
      await this.auditRunLifecycle('agent_run.steps.read', run, actor.actor_id);
    }
    const [steps, toolCalls] = await Promise.all([
      listStepsByRunId(runId),
      listToolCallsByRunId(runId),
    ]);

    return {
      run_id: runId,
      steps,
      tool_calls: toolCalls,
    };
  }

  async getActionReplayTrace(runId: string, actor?: AgentActorContext) {
    const run = await this.getRun(runId, actor);
    const [steps, toolCalls] = await Promise.all([
      listStepsByRunId(runId),
      listToolCallsByRunId(runId),
    ]);
    const trace = buildActionReplayTrace({
      run,
      steps,
      tool_calls: toolCalls,
    });
    assertReplayTraceDeterministic(trace);
    if (actor) {
      await this.auditRunLifecycle('agent_run.action_replay.read', run, actor.actor_id);
    }
    return trace;
  }

  async resumeRun(input: {
    actor: AgentActorContext;
    trace_id: string;
    run_id: string;
    body: ResumeAgentRunRequest;
  }) {
    const run = await this.getRun(input.run_id, input.actor);
    await assertAgentKillSwitchOpen({
      scope: 'resume',
      run_id: input.run_id,
    });
    const nestedResumeToken = normalizeOptionalString(input.body.nested_resume_token);
    if (nestedResumeToken) {
      return this.resumeNestedRuntime({
        actor: input.actor,
        trace_id: input.trace_id,
        run,
        nested_resume_token: nestedResumeToken,
        resume_payload: input.body.resume_payload ?? {},
      });
    }
    const workflowResumeToken = normalizeOptionalString(input.body.workflow_resume_token);
    if (workflowResumeToken) {
      return this.resumeWorkflowWait({
        actor: input.actor,
        trace_id: input.trace_id,
        workflow_resume_token: workflowResumeToken,
        resume_payload: input.body.resume_payload ?? {},
      });
    }
    const taskId = input.body.task_id?.trim();
    if (!taskId) {
      throw new ApiError('VALIDATION_ERROR', 'task_id is required');
    }
    const idempotencyKey = normalizeOptionalString(input.body.idempotency_key);
    let existingResume:
      | Awaited<ReturnType<typeof findResumeRequest>>
      | undefined;

    if (!['interrupted', 'resume_failed'].includes(run.status)) {
      if (idempotencyKey) {
        existingResume = await findResumeRequest({
          run_id: input.run_id,
          task_id: taskId,
          idempotency_key: idempotencyKey,
        });
        if (existingResume?.status === 'completed') {
          return this.getRun(input.run_id, input.actor);
        }
      }
      throw new ApiError('CONFLICT', 'only interrupted agent runs can be resumed');
    }

    if (isPendingToolApprovalRun(run)) {
      const effectiveResumePayload = input.body.resume_payload ?? {};
      const pendingTaskId = readPendingToolApprovalTaskId(run);
      if (loadEnv().agentRunAsyncEnabled) {
        throw new ApiError(
          'CONFLICT',
          'tool approval resume requires synchronous resume path in P8',
        );
      }
      const result = await this.dispatchResume({
        run,
        actor_id: input.actor.actor_id,
        trace_id: input.trace_id,
        task_id: pendingTaskId,
        resume_payload: effectiveResumePayload,
      });
      await this.auditRunResumed(result, input.actor.actor_id, {
        task_id: pendingTaskId,
        resume_request_id: null,
      });
      return result;
    }

    await assertCanResumeAgentRun({
      actor: input.actor,
      run,
      task_id: taskId,
    });

    const fallbackTask = await findFallbackTaskByRun({
      run_id: input.run_id,
      task_id: taskId,
    });
    if (!fallbackTask) {
      throw new ApiError('NOT_FOUND', 'fallback task not found for agent run');
    }
    if (run.state.fallback?.task_id !== taskId) {
      throw new ApiError('CONFLICT', 'task_id is not the current fallback task');
    }

    const checkpoint = await getLatestCheckpoint(input.run_id);
    const checkpointState = checkpoint?.state ?? run.state;
    const effectiveResumePayload = {
      ...(isRecord(fallbackTask.resolved_payload) ? fallbackTask.resolved_payload : {}),
      ...(input.body.resume_payload ?? {}),
    };
    const payloadHash = hashPayload(effectiveResumePayload);
    if (idempotencyKey) {
      existingResume = await findResumeRequest({
        run_id: input.run_id,
        task_id: taskId,
        idempotency_key: idempotencyKey,
      });
      if (existingResume) {
        if (existingResume.payload_hash !== payloadHash) {
          throw new ApiError(
            'CONFLICT',
            'resume idempotency_key was already used with different payload',
          );
        }
        if (existingResume.status === 'completed') {
          return this.getRun(input.run_id, input.actor);
        }
        if (existingResume.status === 'running') {
          throw new ApiError('CONFLICT', 'resume request is already running');
        }
      }
    }
    let resumeRequestId: string | undefined;
    if (!idempotencyKey) {
      throw new ApiError('VALIDATION_ERROR', 'idempotency_key is required for resume');
    }

    if (loadEnv().agentRunAsyncEnabled) {
      try {
        const resumeState: AgentGraphState = {
          ...checkpointState,
          runtime: {
            ...(checkpointState.runtime ?? {}),
            job_id: undefined,
          },
          fallback: {
            ...(checkpointState.fallback ?? {}),
            task_id: taskId,
            reason: checkpointState.fallback?.reason ?? 'agent_resume_queued',
            resume_payload: effectiveResumePayload,
          },
        };
        const queued = await createQueuedResumeJob({
          run_id: input.run_id,
          task_id: taskId,
          idempotency_key: idempotencyKey,
          payload_hash: hashPayload(effectiveResumePayload),
          payload: {
            actor_id: input.actor.actor_id,
            trace_id: input.trace_id,
            resume_payload: effectiveResumePayload,
          },
          state: resumeState,
          expected_version: run.version,
        });
        if (queued.payload_hash !== hashPayload(effectiveResumePayload)) {
          throw new ApiError(
            'CONFLICT',
            'resume idempotency_key was already used with different payload',
          );
        }
        if (!queued.created && queued.status === 'failed') {
          throw new ApiError(
            'CONFLICT',
            'resume request failed previously; retry with a new idempotency_key',
          );
        }
        return withPollUrl(queued.run);
      } catch (error) {
        if (error instanceof Error && error.message === 'AGENT_RESUME_IDEMPOTENCY_PAYLOAD_CONFLICT') {
          throw new ApiError(
            'CONFLICT',
            'resume idempotency_key was already used with different payload',
          );
        }
        if (error instanceof Error && error.message === 'AGENT_RESUME_ACTIVE_CONFLICT') {
          throw new ApiError('CONFLICT', 'resume request is already running');
        }
        if (error instanceof Error && error.message === 'AGENT_RESUME_RUN_STATE_CONFLICT') {
          throw new ApiError('CONFLICT', 'agent run state changed before resume was queued');
        }
        throw error;
      }
    }

    const created = await createResumeRequest({
      run_id: input.run_id,
      task_id: taskId,
      idempotency_key: idempotencyKey,
      payload_hash: hashPayload(effectiveResumePayload),
    });
    resumeRequestId = created.resume_request_id;

    try {
      const result = await this.dispatchResume({
        run: {
          ...run,
          state: checkpointState,
        },
        actor_id: input.actor.actor_id,
        trace_id: input.trace_id,
        task_id: taskId,
        resume_payload: effectiveResumePayload,
      });
      if (resumeRequestId) {
        await completeResumeRequest({
          resume_request_id: resumeRequestId,
          run_id: result.run_id,
        });
      }
      await this.auditRunResumed(result, input.actor.actor_id, {
        task_id: taskId,
        resume_request_id: resumeRequestId,
      });
      return result;
    } catch (error) {
      const message = sanitizeAgentError(error);
      if (resumeRequestId) {
        await failResumeRequest({
          resume_request_id: resumeRequestId,
          error_message: message,
        });
      }
      if (isRetryableResumeError(error)) {
        await this.markRunResumeFailed(run, error);
      } else {
        await this.markRunFailed(run, error);
      }
      throw error;
    }
  }

  private async resumeNestedRuntime(input: {
    actor: AgentActorContext;
    trace_id: string;
    run: AgentRunRow;
    nested_resume_token: string;
    resume_payload: Record<string, unknown>;
  }): Promise<AgentRunRow> {
    await assertCanReadAgentRun({
      actor: input.actor,
      run: input.run,
    });
    const checkpoint = await getNestedRuntimeCheckpointByResumeToken({
      parent_run_id: input.run.run_id,
      resume_token: input.nested_resume_token,
    });
    if (!checkpoint) {
      throw new ApiError('NOT_FOUND', 'nested runtime checkpoint not found');
    }
    if (loadEnv().agentRunAsyncEnabled) {
      const resumeState = buildNestedRuntimeResumeState({
        checkpoint,
        resume_payload: input.resume_payload,
      });
      const updatedRun = await updateRunState({
        run_id: input.run.run_id,
        status: 'resuming',
        current_node: 'nested_resume_queued',
        state: resumeState,
        expected_version: input.run.version,
        allow_terminal_override: true,
      });
      if (!updatedRun) {
        throw new ApiError('CONFLICT', 'agent run state changed before nested resume was queued');
      }
      await createRunJob({
        run_id: input.run.run_id,
        job_type: 'resume',
        payload: {
          actor_id: input.actor.actor_id,
          trace_id: input.trace_id,
          task_id: checkpoint.lineage.task_id ?? 'nested_runtime',
          resume_payload: input.resume_payload,
          nested_resume_token: input.nested_resume_token,
          nested_checkpoint_id: checkpoint.checkpoint_id,
          nested_runtime_id: checkpoint.lineage.runtime_id,
          payload_hash: hashPayload(input.resume_payload),
        },
      });
      await saveCheckpoint({
        run_id: input.run.run_id,
        state: resumeState,
        status: 'nested_resume_queued',
      });
      await agentStepRecorder.recordStep({
        run_id: input.run.run_id,
        node_name: 'nested_runtime_resume_queued',
        agent_type: checkpoint.lineage.agent_type,
        status: 'completed',
        input: {
          resume_token: input.nested_resume_token,
          checkpoint_id: checkpoint.checkpoint_id,
        },
        output: {
          queued: true,
          runtime_id: checkpoint.lineage.runtime_id,
          target_phase: checkpoint.lineage.target_phase,
        },
      });
      return withPollUrl(updatedRun);
    }
    return this.dispatchNestedResume({
      run: input.run,
      actor_id: input.actor.actor_id,
      trace_id: input.trace_id,
      checkpoint,
      nested_resume_token: input.nested_resume_token,
      resume_payload: input.resume_payload,
    });
  }

  private async resumeWorkflowWait(input: {
    actor: AgentActorContext;
    trace_id: string;
    workflow_resume_token: string;
    resume_payload: Record<string, unknown>;
  }): Promise<AgentRunRow> {
    await assertAgentKillSwitchOpen({
      scope: 'resume',
    });
    return resumeWorkflowWaitByToken({
      resume_token: input.workflow_resume_token,
      payload: input.resume_payload,
      actor_id: input.actor.actor_id,
      trace_id: input.trace_id,
    });
  }

  async dispatchNestedResume(input: {
    run: AgentRunRow;
    actor_id: string;
    trace_id: string;
    checkpoint: NonNullable<Awaited<ReturnType<typeof getNestedRuntimeCheckpointByResumeToken>>>;
    nested_resume_token: string;
    resume_payload: Record<string, unknown>;
  }): Promise<AgentRunRow> {
    const runtimeResult = await resumeNestedAgentRuntime({
      run: {
        ...input.run,
        state: buildNestedRuntimeResumeState({
          checkpoint: input.checkpoint,
          resume_payload: input.resume_payload,
        }),
      },
      resume_payload: input.resume_payload,
      checkpoint: input.checkpoint,
    });
    await agentStepRecorder.recordStep({
      run_id: input.run.run_id,
      node_name: 'nested_runtime_resume',
      agent_type: input.checkpoint.lineage.agent_type,
      status: runtimeResult.step_status,
      input: {
        resume_token: input.nested_resume_token,
        checkpoint_id: input.checkpoint.checkpoint_id,
        runtime_id: input.checkpoint.lineage.runtime_id,
      },
      output: {
        resumed: runtimeResult.step_status === 'completed',
        runtime_id: input.checkpoint.lineage.runtime_id,
        target_phase: input.checkpoint.lineage.target_phase,
        child_output: runtimeResult.output,
      },
      error_message: runtimeResult.error_message,
    });
    await saveCheckpoint({
      run_id: input.run.run_id,
      state: runtimeResult.state,
      status: runtimeResult.checkpoint_status,
    });
    const updated = await updateRunStateIfLeased({
      run_id: input.run.run_id,
      status: runtimeResult.parent_status,
      current_node: runtimeResult.current_node,
      state: runtimeResult.state,
      error_message: runtimeResult.error_message,
      allow_terminal_override: true,
    });
    if (!updated) {
      throw new ApiError('CONFLICT', 'agent run worker lease lost before nested resume update');
    }
    await this.auditRunResumed(updated, input.actor_id, {
      task_id: input.checkpoint.lineage.task_id ?? 'nested_runtime',
      resume_request_id: null,
      nested_runtime_id: input.checkpoint.lineage.runtime_id,
      nested_resume_token: input.nested_resume_token,
      nested_checkpoint_id: input.checkpoint.checkpoint_id,
    });
    return updated;
  }

  async dispatchResume(input: {
    run: AgentRunRow;
    actor_id: string;
    trace_id: string;
    task_id: string;
    resume_payload: Record<string, unknown>;
  }): Promise<AgentRunRow> {
    await assertAgentKillSwitchOpen({
      scope: 'resume',
      run_id: input.run.run_id,
    });
    await assertRunBudgetAvailable(input.run);
    if (isPendingToolApprovalRun(input.run)) {
      return agentRuntimeLoop.resumePendingToolApproval({
        run: input.run,
        actor_id: input.actor_id,
        trace_id: input.trace_id,
        resume_payload: input.resume_payload,
      });
    }
    if (input.run.entrypoint === 'consultation') {
      return this.finalizeDispatchedRun(await consultationGraphRunner.resume(input));
    }
    if (input.run.entrypoint === 'application') {
      return this.finalizeDispatchedRun(await applicationGraphRunner.resume(input));
    }
    if (input.run.entrypoint === 'review') {
      return this.finalizeDispatchedRun(await reviewGraphRunner.resume(input));
    }
    return this.finalizeDispatchedRun(await mockGraphRunner.resume(input));
  }

  async replayRun(input: {
    actor: AgentActorContext;
    trace_id: string;
    run_id: string;
    reason?: string;
  }) {
    const sourceRun = await this.getRun(input.run_id, input.actor);
    await assertCanStartAgentRun({
      actor: input.actor,
      entrypoint: sourceRun.entrypoint,
      bodyInput: sourceRun.state.input,
      production: loadEnv().nodeEnv === 'production',
    });
    const replay = await createReplayRecord({
      source_run_id: sourceRun.run_id,
      actor_id: input.actor.actor_id,
      reason: input.reason,
      trace_id: input.trace_id,
    });
    const replayId = readReplayId(replay);
    let replayRun: AgentRunRow | undefined;
    try {
      replayRun = await this.startRun({
        actor: input.actor,
        trace_id: input.trace_id,
        body: {
          entrypoint: sourceRun.entrypoint,
          input: {
            ...sourceRun.state.input,
            replay: {
              source_run_id: sourceRun.run_id,
              reason: input.reason ?? null,
              requested_at: new Date().toISOString(),
            },
          },
          idempotency_key: undefined,
        },
      });
    } catch (error) {
      await markReplayFailed({
        replay_id: replayId,
        source_run_id: sourceRun.run_id,
        replay_run_id: replayRun?.run_id,
        actor_id: input.actor.actor_id,
        trace_id: input.trace_id,
        error_message: sanitizeAgentError(error),
      });
      throw error;
    }
    const attachedReplay = await attachReplayRun({
      replay_id: replayId,
      replay_run_id: replayRun.run_id,
    });
    return {
      replay: attachedReplay,
      run: replayRun,
    };
  }

  private assertEntrypoint(value: unknown): AgentRunEntrypoint {
    if (typeof value !== 'string' || !ENTRYPOINTS.has(value as AgentRunEntrypoint)) {
      throw new ApiError('VALIDATION_ERROR', 'invalid agent run entrypoint');
    }

    return value as AgentRunEntrypoint;
  }

  async markRunFailed(run: AgentRunRow, error: unknown): Promise<void> {
    const message = sanitizeAgentError(error);
    const state: AgentGraphState = {
      ...run.state,
      current_node: 'failed',
      errors: [
        ...(run.state.errors ?? []),
        {
          node: run.current_node ?? 'unknown',
          message,
        },
      ],
    };

    await updateRunState({
      run_id: run.run_id,
      status: 'failed',
      current_node: 'failed',
      state,
      error_message: message,
    });
    await agentStepRecorder.recordStep({
      run_id: run.run_id,
      node_name: 'agent_run_failed',
      agent_type: 'system',
      status: 'failed',
      input: {
        entrypoint: run.entrypoint,
        previous_node: run.current_node,
      },
      output: {},
      error_message: message,
    });
    await saveCheckpoint({
      run_id: run.run_id,
      state,
      status: 'failed',
    });
    await releaseRunQuotaReservation(run.run_id);
    await this.auditRunLifecycle('agent_run.failed', run, run.actor_id, {
      error_type: message,
    });
  }

  async markRunResumeFailed(run: AgentRunRow, error: unknown): Promise<void> {
    const message = sanitizeAgentError(error);
    const state: AgentGraphState = {
      ...run.state,
      current_node: 'resume_failed',
      errors: [
        ...(run.state.errors ?? []),
        {
          node: run.current_node ?? 'resume',
          message,
        },
      ],
    };

    await updateRunState({
      run_id: run.run_id,
      status: 'resume_failed',
      current_node: 'resume_failed',
      state,
      error_message: message,
    });
    await agentStepRecorder.recordStep({
      run_id: run.run_id,
      node_name: 'agent_resume_failed',
      agent_type: 'system',
      status: 'failed',
      input: {
        entrypoint: run.entrypoint,
        previous_node: run.current_node,
      },
      output: {},
      error_message: message,
    });
    await saveCheckpoint({
      run_id: run.run_id,
      state,
      status: 'resume_failed',
    });
    await this.auditRunLifecycle('agent_run.resume_failed', run, run.actor_id, {
      error_type: message,
    });
  }

  async auditRunResumed(
    run: AgentRunRow,
    actorId: string,
    detail: {
      task_id: string;
      resume_request_id?: string | null;
      nested_runtime_id?: string;
      nested_resume_token?: string;
      nested_checkpoint_id?: string;
    },
  ): Promise<void> {
    await this.auditRunLifecycle('agent_run.resumed', run, actorId, detail);
  }

  async markRunTerminalCompleted(run: AgentRunRow): Promise<void> {
    await releaseRunQuotaReservation(run.run_id);
    await this.auditRunLifecycle('agent_run.completed', run, run.actor_id);
  }

  private async finalizeDispatchedRun(run: AgentRunRow): Promise<AgentRunRow> {
    if (['completed', 'interrupted', 'failed', 'cancelled'].includes(run.status)) {
      await releaseRunQuotaReservation(run.run_id);
      await this.auditRunLifecycle(
        run.status === 'completed'
          ? 'agent_run.completed'
          : run.status === 'interrupted'
            ? 'agent_run.interrupted'
            : `agent_run.${run.status}`,
        run,
        run.actor_id,
      );
    }
    return run;
  }

  private async findExistingIdempotentRun(input: {
    actor_id: string;
    entrypoint: AgentRunEntrypoint;
    idempotency_key?: string;
    bodyInput: Record<string, unknown>;
  }): Promise<AgentRunRow | undefined> {
    try {
      return await findRunByScopedIdempotencyKey({
        actor_id: input.actor_id,
        entrypoint: input.entrypoint,
        idempotency_key: input.idempotency_key,
        business_scope: input.bodyInput,
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'AGENT_IDEMPOTENCY_SCOPE_CONFLICT') {
        throw new ApiError(
          'CONFLICT',
          'idempotency_key was already used for a different agent business object',
        );
      }
      throw error;
    }
  }

  private async auditRunLifecycle(
    action: string,
    run: AgentRunRow,
    actorId: string,
    detail: Record<string, unknown> = {},
  ): Promise<void> {
    await auditService.write({
      actor_id: actorId,
      action,
      target_type: 'agent_run',
      target_id: run.run_id,
      trace_id: run.trace_id ?? run.state.trace_id,
      detail: {
        run_id: run.run_id,
        entrypoint: run.entrypoint,
        status: run.status,
        business_type: run.entrypoint,
        business_id: readBusinessId(run.state.input),
        ...detail,
      },
    });
  }

  private async createQueuedRunSafely(input: Parameters<typeof createQueuedRunWithJob>[0]) {
    try {
      return await createQueuedRunWithJob(input);
    } catch (error) {
      if (error instanceof Error && error.message === 'AGENT_USER_CONCURRENCY_LIMIT') {
        throw new ApiError('RATE_LIMITED', 'agent user concurrency limit exceeded', {
          limit_type: 'user_concurrency',
        });
      }
      if (error instanceof Error && error.message === 'AGENT_GLOBAL_CONCURRENCY_LIMIT') {
        throw new ApiError('RATE_LIMITED', 'agent global concurrency limit exceeded', {
          limit_type: 'global_concurrency',
        });
      }
      throw error;
    }
  }
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function isPendingToolApprovalRun(run: AgentRunRow): boolean {
  return Boolean(run.state.runtime?.pending_tool_approval);
}

function readPendingToolApprovalTaskId(run: AgentRunRow): string {
  const approvalId = run.state.runtime?.pending_tool_approval?.approval_id;
  return typeof approvalId === 'string' && approvalId.trim() !== ''
    ? approvalId.trim()
    : 'tool_approval';
}

export const agentRunService = new AgentRunService();

function withPollUrl(run: AgentRunRow): AgentRunRow & { poll_url: string } {
  return {
    ...run,
    poll_url: `/api/v1/agent-runs/${run.run_id}`,
  };
}

function hashPayload(payload: Record<string, unknown>): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(sortJson(payload)))
    .digest('hex');
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortJson(child)]),
    );
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function readReplayId(value: unknown): string {
  if (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof (value as { replay_id?: unknown }).replay_id === 'string'
  ) {
    return (value as { replay_id: string }).replay_id;
  }
  throw new ApiError('INTERNAL_ERROR', 'failed to create replay record');
}

function readRequestedFanoutMode(
  input: Record<string, unknown>,
): 'sequential' | 'parallel' | undefined {
  const runtime = input.runtime;
  if (!isRecord(runtime)) {
    return undefined;
  }
  return runtime.fanout_mode === 'parallel' ? 'parallel' : undefined;
}

function readRequestedOrchestrationMode(
  input: CreateAgentRunRequest,
): 'phase_guarded' | 'cross_domain' | undefined {
  return input.orchestration?.mode === 'cross_domain'
    ? 'cross_domain'
    : undefined;
}

function isRetryableResumeError(error: unknown): boolean {
  const maybe = error as { retryable?: unknown; type?: unknown };
  if (maybe.retryable === true) {
    return true;
  }
  return maybe.type === 'timeout' || maybe.type === 'rate_limit';
}

function readBusinessId(input: Record<string, unknown>): string | null {
  for (const key of ['application_id', 'item_id', 'policy_id', 'enterprise_id']) {
    const value = input[key];
    if (typeof value === 'string' && value.trim() !== '') {
      return value.trim();
    }
  }
  return null;
}

export function sanitizeAgentError(error: unknown): string {
  const maybe = error as {
    type?: unknown;
    status?: unknown;
    retryable?: unknown;
  };
  if (typeof maybe.type === 'string') {
    if (maybe.type === 'configuration') {
      return 'llm configuration error';
    }
    if (maybe.type === 'authentication') {
      return 'llm authentication failed';
    }
    if (maybe.type === 'invalid_response') {
      return 'llm invalid response';
    }
    if (maybe.type === 'timeout') {
      return 'llm request timed out';
    }
    return `llm ${maybe.type} error`;
  }

  if (error instanceof ApiError) {
    return error.message;
  }

  return 'agent run failed';
}
