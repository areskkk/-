import { AsyncLocalStorage } from 'node:async_hooks';

export type AgentRunLease = {
  job_id: string;
  worker_id: string;
};

const leaseStorage = new AsyncLocalStorage<AgentRunLease>();

export function runWithAgentLease<T>(
  lease: AgentRunLease,
  callback: () => Promise<T>,
): Promise<T> {
  return leaseStorage.run(lease, callback);
}

export function getCurrentAgentLease(): AgentRunLease | undefined {
  return leaseStorage.getStore();
}

export function readAgentLeaseFromState(state: {
  runtime?: {
    job_id?: string;
    worker_id?: string;
  };
}): AgentRunLease | undefined {
  const jobId = state.runtime?.job_id;
  const workerId = state.runtime?.worker_id;
  if (!jobId || !workerId) {
    return undefined;
  }
  return {
    job_id: jobId,
    worker_id: workerId,
  };
}
