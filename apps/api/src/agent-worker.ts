import { loadEnv } from './config/env.js';
import { agentRunWorker } from './modules/agents/runtime/agent-run-worker.js';
import { ocrJobWorker } from './modules/ocr/ocr-job-worker.js';

let shuttingDown = false;

async function main(): Promise<void> {
  process.env.AGENT_RUN_WORKER_AUTOSTART = 'true';
  agentRunWorker.start();
  ocrJobWorker.start();
  console.log(`agent worker started id=${loadEnv().agentRunWorkerId}`);
}

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log(`agent worker draining signal=${signal}`);
  agentRunWorker.stop();
  ocrJobWorker.stop();
  await agentRunWorker.drainOnce(1).catch(() => undefined);
  await ocrJobWorker.drainOnce(1).catch(() => undefined);
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

void main().catch((error) => {
  console.error('agent worker failed to start', error);
  process.exit(1);
});
