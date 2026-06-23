import { loadEnv } from '../../config/env.js';
import {
  claimNextOcrJob,
  completeLeasedOcrJob,
  failLeasedOcrJob,
  heartbeatOcrJob,
} from './ocr-job.repository.js';
import { ocrService } from './ocr.service.js';

function getHeartbeatIntervalMs(): number {
  const env = loadEnv();
  const leaseWindowMs = Math.min(env.agentRunStaleRunningMs, env.ocrServiceTimeoutMs);
  return Math.max(50, Math.floor(leaseWindowMs / 3));
}

export class OcrJobWorker {
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
    const workerId = loadEnv().agentRunWorkerId;
    try {
      for (let index = 0; index < maxJobs; index += 1) {
        const job = await claimNextOcrJob({
          worker_id: workerId,
          stale_running_ms: loadEnv().agentRunStaleRunningMs,
        });
        if (!job) {
          break;
        }
        processed += 1;
        const heartbeat = setInterval(() => {
          void heartbeatOcrJob({
            job_id: job.job_id,
            worker_id: workerId,
          }).catch(() => undefined);
        }, getHeartbeatIntervalMs());
        heartbeat.unref();
        try {
          await ocrService.runAnalyzeForMaterial(
            job.actor_id,
            job.trace_id,
            job.material_id,
            { markFailureOnError: false },
          );
          await completeLeasedOcrJob({
            job_id: job.job_id,
            worker_id: workerId,
          });
        } catch (error) {
          const failedJob = await failLeasedOcrJob({
            job_id: job.job_id,
            worker_id: workerId,
            error_message: error instanceof Error ? error.message : 'ocr job failed',
            retry_delay_ms: 1000,
          });
          if (failedJob?.status === 'failed') {
            await ocrService.markAnalyzeFailed(
              job.actor_id,
              job.trace_id,
              job.material_id,
              error instanceof Error ? error.message : 'ocr job failed',
            );
          }
        } finally {
          clearInterval(heartbeat);
        }
      }
      return processed;
    } finally {
      this.running = false;
    }
  }
}

export const ocrJobWorker = new OcrJobWorker();
