export type FallbackSourceType =
  | 'policy_qa'
  | 'eligibility'
  | 'ocr'
  | 'rag_retrieval'
  | 'agent_run';

export type FallbackStatus = 'pending' | 'processing' | 'resolved' | 'closed';

export type FallbackResolutionType =
  | 'answer'
  | 'field_patch'
  | 'material_confirm'
  | 'close';

export type CreateFallbackTaskInput = {
  actor_id: string;
  trace_id: string;
  source_type: FallbackSourceType;
  source_id: string;
  reason: string;
  context: Record<string, unknown>;
  run_id?: string;
  job_id?: string;
  worker_id?: string;
};

export type ResolveFallbackTaskInput = {
  resolution_type: FallbackResolutionType;
  comment: string;
  resolved_payload?: Record<string, unknown>;
};

export type FallbackTaskRow = {
  task_id: string;
  run_id: string | null;
  reason: string;
  source_type: FallbackSourceType;
  source_id: string;
  context: Record<string, unknown>;
  status: FallbackStatus;
  owner_team: string;
  due_at: string | null;
  resolved_payload: Record<string, unknown> | null;
  resolution_type: FallbackResolutionType | null;
  resolved_by: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
};
