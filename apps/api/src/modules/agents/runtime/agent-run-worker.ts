import { loadEnv } from '../../../config/env.js';
import {
  assertRunJobLease,
  claimNextRunJob,
  completeLeasedRunJob,
  completeResumeRequest,
  failLeasedRunJob,
  failLeasedRunJobPermanently,
  failResumeRequest,
  findRunById,
  heartbeatRunJob,
} from '../agents.repository.js';
import { agentRunService, sanitizeAgentError } from '../agents.service.js';
import { type AgentRunRow } from '../agents.types.js';
import { runWithAgentLease } from './agent-lease-context.js';
import {
  getNestedRuntimeCheckpointByResumeToken,
  getNestedRuntimeCheckpointByRuntimeId,
} from './nested-runtime-checkpoint.js';

export class AgentRunWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  start(): void {
    if (this.timer || !loadEnv().agentRunWorkerAutostart) {
      return;
    }
    this.timer = setInterval(() => {
      void this.drainOnce().catch(() => undefined);
    }, loadEnv().agentRunWorkerPollMs);
    this.timer.unref();
    void this.drainOnce().catch(() => undefined);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async drainOnce(maxJobs = 10): Promise<number> {
    if (this.running) {
      return 0;
    }
    this.running = true;
    let processed = 0;
    try {
      for (let index = 0; index < maxJobs; index += 1) {
        const job = await claimNextRunJob({
          worker_id: loadEnv().agentRunWorkerId,
          stale_running_ms: loadEnv().agentRunStaleRunningMs,
        });
        if (!job) {
          break;
        }
        processed += 1;
        await this.processJob(job);
      }
      return processed;
    } finally {
      this.running = false;
    }
  }

  private async processJob(job: {
    job_id: string;
    run_id: string;
    job_type: 'start' | 'resume';
    attempt_count: number;
    max_attempts: number;
    payload: Record<string, unknown>;
    last_error: string | null;
  }): Promise<void> {
    const workerId = loadEnv().agentRunWorkerId;
    const run = await findRunById(job.run_id);
    if (!run) {
      await failLeasedRunJob({
        job_id: job.job_id,
        worker_id: workerId,
        error_message: 'agent run not found',
      });
      return;
    }

    if (['completed', 'failed', 'cancelled'].includes(run.status)) {
      await completeLeasedRunJob({
        job_id: job.job_id,
        worker_id: workerId,
      });
      return;
    }

    const leasedRun = attachLeaseToRun(run, job.job_id, workerId);
    if (
      job.job_type === 'start'
      && run.status === 'running'
      && job.attempt_count > 1
      && job.last_error === 'worker lease expired'
    ) {
      const error = new Error('agent run worker lease expired before completion');
      const message = sanitizeAgentError(error);
      await failLeasedRunJobPermanently({
        job_id: job.job_id,
        worker_id: workerId,
        error_message: message,
      });
      await agentRunService.markRunFailed(stripLeaseFromRun(leasedRun), error);
      return;
    }

    let leaseLost = false;
    const assertLease = async (): Promise<void> => {
      if (leaseLost) {
        throw new Error('agent run worker lease lost before completion');
      }
      const leased = await assertRunJobLease({
        job_id: job.job_id,
        worker_id: workerId,
      });
      if (!leased) {
        leaseLost = true;
        throw new Error('agent run worker lease lost before completion');
      }
    };

    const heartbeat = setInterval(() => {
      void heartbeatRunJob({
        job_id: job.job_id,
        worker_id: workerId,
      })
        .then((leased) => {
          if (!leased) {
            leaseLost = true;
          }
        })
        .catch(() => {
          leaseLost = true;
        });
    }, Math.max(250, Math.floor(loadEnv().agentRunStaleRunningMs / 3)));
    heartbeat.unref();

    try {
      await assertLease();
      await runWithAgentLease(
        {
          job_id: job.job_id,
          worker_id: workerId,
        },
        async () => {
          if (job.job_type === 'resume') {
            await this.dispatchResumeJob(leasedRun, job.payload);
          } else {
            await agentRunService.dispatchRun({
              run: leasedRun,
              actor_id: readString(job.payload.actor_id) ?? run.actor_id,
              trace_id: readString(job.payload.trace_id) ?? run.trace_id ?? run.state.trace_id,
            });
          }
        },
      );
      await assertLease();
      await completeLeasedRunJob({
        job_id: job.job_id,
        worker_id: workerId,
      });
    } catch (error) {
      const message = sanitizeAgentError(error);
      const failedJob = await failLeasedRunJob({
        job_id: job.job_id,
        worker_id: workerId,
        error_message: message,
        retry_delay_ms: 10,
      });
      if (failedJob?.status === 'failed') {
        if (job.job_type === 'resume') {
          const resumeRequestId = readString(job.payload.resume_request_id);
          if (resumeRequestId) {
            await failResumeRequest({
              resume_request_id: resumeRequestId,
              error_message: message,
            });
          }
          await agentRunService.markRunResumeFailed(stripLeaseFromRun(leasedRun), error);
        } else {
          await agentRunService.markRunFailed(stripLeaseFromRun(leasedRun), error);
        }
      }
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async dispatchResumeJob(
    run: AgentRunRow,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const taskId = readString(payload.task_id);
    const resumeRequestId = readString(payload.resume_request_id);
    const nestedResumeToken = readString(payload.nested_resume_token);
    const nestedRuntimeId = readString(payload.nested_runtime_id);
    const resumePayload = isRecord(payload.resume_payload)
      ? payload.resume_payload
      : {};
    if (!taskId) {
      throw new Error('resume job task_id is required');
    }
    const actorId = readString(payload.actor_id) ?? run.actor_id;
    const traceId = readString(payload.trace_id) ?? run.trace_id ?? run.state.trace_id;
    const nestedCheckpoint = nestedResumeToken
      ? nestedRuntimeId
        ? await getNestedRuntimeCheckpointByRuntimeId({
            parent_run_id: run.run_id,
            runtime_id: nestedRuntimeId,
          })
        : await getNestedRuntimeCheckpointByResumeToken({
            parent_run_id: run.run_id,
            resume_token: nestedResumeToken,
          })
      : undefined;
    if (nestedResumeToken && !nestedCheckpoint) {
      throw new Error('nested runtime checkpoint not found');
    }
    const result = nestedCheckpoint && nestedResumeToken
      ? await agentRunService.dispatchNestedResume({
          run,
          actor_id: actorId,
          trace_id: traceId,
          checkpoint: nestedCheckpoint,
          nested_resume_token: nestedResumeToken,
          resume_payload: resumePayload,
        })
      : await agentRunService.dispatchResume({
          run,
          actor_id: actorId,
          trace_id: traceId,
          task_id: taskId,
          resume_payload: resumePayload,
        });
    if (resumeRequestId) {
      await completeResumeRequest({
        resume_request_id: resumeRequestId,
        run_id: result.run_id,
      });
    }
    if (nestedCheckpoint) {
      return;
    }
    await agentRunService.auditRunResumed(result, actorId, {
      task_id: taskId,
      resume_request_id: resumeRequestId ?? null,
    });
  }
}

export const agentRunWorker = new AgentRunWorker();

function attachLeaseToRun(
  run: AgentRunRow,
  jobId: string,
  workerId: string,
): AgentRunRow {
  return {
    ...run,
    state: {
      ...run.state,
      runtime: {
        ...(run.state.runtime ?? {}),
        job_id: jobId,
        worker_id: workerId,
      },
    },
  };
}

function stripLeaseFromRun(run: AgentRunRow): AgentRunRow {
  return {
    ...run,
    state: {
      ...run.state,
      runtime: {
        ...(run.state.runtime ?? {}),
        job_id: undefined,
      },
    },
  };
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== ''
    ? value.trim()
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
