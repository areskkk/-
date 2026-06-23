export type AgentRunStatus =
  | 'queued'
  | 'running'
  | 'resuming'
  | 'resume_failed'
  | 'interrupted'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type AgentRunJobStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type AgentRunJobType = 'start' | 'resume';

export type AgentRunEntrypoint =
  | 'consultation'
  | 'application'
  | 'review'
  | 'mock_completed'
  | 'mock_failed'
  | 'mock_interrupted';

export type AgentStepStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'interrupted';

export type AgentToolCallStatus = 'running' | 'completed' | 'failed';

export type AgentGraphState = {
  run_id: string;
  trace_id: string;
  actor_id: string;
  entrypoint: AgentRunEntrypoint;
  input: Record<string, unknown>;
  intent?: {
    intent_type: string;
    confidence: number;
    missing_fields: string[];
    next_node: string;
  };
  retrieval?: {
    query: string;
    citations: unknown[];
    confidence: number;
    backend_mode: string;
  };
  policy_analysis?: {
    result: string;
    matched_conditions: unknown[];
    missing_fields: string[];
    explanation: string;
    confidence: number;
    answer?: string;
  };
  application_assist?: {
    checklist: string[];
    missing_materials: string[];
    confidence: number;
  };
  review_agent?: {
    review_focus: string[];
    evidence_questions: string[];
    confidence: number;
  };
  ocr?: {
    materials: Array<{
      material_id: string;
      material_type: string;
      ocr_status: string;
      ocr_result_id: string | null;
      overall_confidence: number | null;
      requires_manual_confirmation: boolean;
      hard_evidence_allowed: boolean;
      low_confidence_fields: Array<{
        field: string;
        confidence: number;
      }>;
      warnings: string[];
      fields: Record<string, unknown>;
    }>;
    low_confidence_material_ids: string[];
    hard_evidence_notice: string;
  };
  document_vision?: {
    risk_items: Array<{
      field: string;
      severity: 'low' | 'medium' | 'high';
      reason: string;
    }>;
    usable_as_hard_evidence: boolean;
    confidence: number;
  };
  eligibility?: {
    result: string;
    matched_conditions: unknown[];
    failed_conditions: unknown[];
    missing_fields: string[];
    citations: unknown[];
    evidence_refs: unknown[];
    fallback_task: unknown;
    ai_summary: string;
    rule_first: boolean;
  };
  math_verification?: {
    verdict: 'pass' | 'fail' | 'unknown';
    explanation: string;
    checked_conditions: unknown[];
    confidence: number;
  };
  judge?: {
    approved: boolean;
    should_fallback: boolean;
    reasons: string[];
    confidence: number;
  };
  final?: {
    status: string;
    answer?: string;
    next_actions?: string[];
    citations?: unknown[];
  };
  review_draft?: {
    draft_id: string;
    status: string;
    suggested_decision: string;
    opinion: string;
    risk_items: unknown[];
    missing_evidence: unknown[];
    no_auto_decision: boolean;
  };
  fallback?: {
    task_id: string;
    reason: string;
    resume_payload?: unknown;
  };
  runtime?: {
    queued_at?: string;
    worker_id?: string;
    job_id?: string;
    started_at?: string;
    phase?: AgentRunEntrypoint;
    active_agent?: string;
    max_turns?: number;
    turn_count?: number;
    fanout_mode?: 'sequential' | 'parallel';
    budget?: {
      max_run_tokens: number;
      max_run_cost_cents: number;
      used_tokens: number;
      estimated_cost_cents: number;
    };
    rate_limit?: Record<string, unknown>;
    retry_probe_failed?: boolean;
    actor?: {
      roles: string[];
      user_type?: string;
    };
    coordinator?: {
      agent_type: string;
      action: string;
      delegated_subagents: string[];
      fanout_count: number;
      fanout_mode?: string;
      fanin_strategy?: string;
      fanin_completed: boolean;
      permission_scope?: {
        entrypoint: string;
        item_id?: string;
        application_id?: string;
        allowed_subagents: string[];
      };
      budget?: {
        max_subagents: number;
        max_turns_per_subagent: number;
        verifier_required: boolean;
      };
    };
    subagents?: Array<{
      agent_type: string;
      result_kind?: 'raw_task_output';
      status: string;
      runtime?: {
        parent_run_id?: string;
        task_id?: string;
        runtime_id: string;
        checkpoint_id: string;
        resume_token: string;
      };
      permission_scope?: {
        entrypoint: string;
        item_id?: string;
        application_id?: string;
      };
      budget?: {
        max_turns: number;
        max_tool_calls: number;
      };
      capabilities?: {
        independent_tool_loop: boolean;
        can_delegate: boolean;
        can_request_human: boolean;
      };
      turn_count?: number;
      tool_call_count?: number;
      output: unknown;
      error_message?: string;
    }>;
    verifier?: {
      agent_type: string;
      result_kind?: 'final_verifier_result';
      status: string;
      permission_scope?: {
        entrypoint: string;
        item_id?: string;
        application_id?: string;
      };
      budget?: {
        max_turns: number;
        required: boolean;
      };
      final_judge?: unknown;
      judge: unknown;
    };
    orchestration_contract?: Record<string, unknown>;
    arbitration?: Record<string, unknown>;
    saga?: Record<string, unknown>;
    tool_semantics?: Record<string, unknown>;
    workflow?: Record<string, unknown>;
    pending_tool_approval?: {
      approval_id: string;
      status: 'pending' | 'approved' | 'rejected' | 'completed';
      action: {
        action: 'call_tool';
        tool_name: string;
        tool_input: Record<string, unknown>;
        rationale?: string;
      };
      phase: string;
      agent_type: string;
      tool_scope: Record<string, unknown>;
      semantic_decision: Record<string, unknown>;
      requested_at: string;
      decided_at?: string;
      rejection_reason?: string;
    };
    coordinator_registry?: Record<string, unknown>;
    task_graph?: Record<string, unknown>;
    cross_domain?: {
      from_phase: AgentRunEntrypoint;
      target_phase: AgentRunEntrypoint;
      mode: string;
      context?: Record<string, unknown>;
      boundaries?: Record<string, unknown>;
    };
    nested_checkpoint?: {
      parent_run_id: string;
      runtime_id: string;
      task_id?: string;
      resume_token: string;
      from_phase: string;
      target_phase: string;
      agent_type: string;
      status: string;
      checkpoint_status?: string;
    };
    nested_resume?: {
      parent_run_id: string;
      runtime_id: string;
      task_id?: string;
      resume_token: string;
      resumed_from_checkpoint_id: string;
      target_phase: string;
      payload: Record<string, unknown>;
      status?: 'queued' | 'resuming' | 'completed' | 'interrupted' | 'failed';
      output?: unknown;
      error_message?: string;
      completed_at?: string;
    };
  };
  artifact_graph?: Record<string, unknown>;
  resume_history?: Array<{
    task_id: string;
    idempotency_key: string;
    completed_at: string;
  }>;
  errors: Array<{
    node: string;
    message: string;
  }>;
  [key: string]: unknown;
};

export type AgentRunRow = {
  run_id: string;
  actor_id: string;
  entrypoint: AgentRunEntrypoint;
  status: AgentRunStatus;
  current_node: string | null;
  state: AgentGraphState;
  idempotency_key: string | null;
  trace_id: string | null;
  error_message: string | null;
  started_at: string;
  interrupted_at: string | null;
  completed_at: string | null;
  updated_at: string;
  version: number;
};

export type AgentRunStepRow = {
  step_id: string;
  run_id: string;
  node_name: string;
  agent_type: string | null;
  model_name: string | null;
  prompt_template_id: string | null;
  status: AgentStepStatus;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  tool_calls: unknown[];
  token_usage: Record<string, unknown>;
  error_message: string | null;
  started_at: string;
  completed_at: string | null;
};

export type AgentToolCallRow = {
  tool_call_id: string;
  run_id: string;
  step_id: string | null;
  tool_name: string;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  status: AgentToolCallStatus;
  error_message: string | null;
  started_at: string;
  completed_at: string | null;
};

export type AgentRunJobRow = {
  job_id: string;
  run_id: string;
  job_type: AgentRunJobType;
  status: AgentRunJobStatus;
  priority: number;
  attempt_count: number;
  max_attempts: number;
  locked_by: string | null;
  locked_at: string | null;
  heartbeat_at: string | null;
  available_at: string;
  last_error: string | null;
  payload: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export type CreateAgentRunRequest = {
  entrypoint: AgentRunEntrypoint;
  input?: Record<string, unknown>;
  idempotency_key?: string;
  orchestration?: {
    mode?: 'phase_guarded' | 'cross_domain';
  };
};

export type ResumeAgentRunRequest = {
  task_id?: string;
  nested_resume_token?: string;
  workflow_resume_token?: string;
  resume_payload?: Record<string, unknown>;
  idempotency_key?: string;
};
