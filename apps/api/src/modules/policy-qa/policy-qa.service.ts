import { ApiError } from '../../common/errors/http-error.js';
import { loadEnv } from '../../config/env.js';
import { agentRunService } from '../agents/agents.service.js';
import { type AgentRunRow } from '../agents/agents.types.js';
import { auditService } from '../audit/audit.service.js';
import {
  listWhitelistedEffectivePolicies,
  type QaPolicyRow,
} from './policy-qa.repository.js';
import {
  createPolicyQaSourceId,
  fallbackService,
  normalizeQuestion,
} from '../fallback/fallback.service.js';
import { ragService } from '../rag/rag.service.js';
import { type RagCitation, type RagSearchResult } from '../rag/rag.types.js';

export type PolicyQaRequest = {
  question: string;
  policy_id?: string;
  runtime?: {
    fanout_mode?: 'parallel' | 'sequential';
  };
};

type QaStatus = 'answered' | 'need_info' | 'manual_review';

type Citation = {
  policy_id: string;
  title: string;
  version: string;
  source_name: string | null;
  source_url: string | null;
  snippet: string;
};

type ScoredPolicy = {
  policy: QaPolicyRow;
  confidence: number;
  title_hits: number;
  content_hits: number;
  source_hit: boolean;
  snippet: string;
};

const CONFIDENCE_THRESHOLD = 0.75;
const STOP_WORDS = new Set([
  '我',
  '我们',
  '企业',
  '公司',
  '可以',
  '能否',
  '能不能',
  '是否',
  '怎么',
  '如何',
  '申请',
  '申报',
  '政策',
  '补贴',
  '奖励',
  '的',
  '了',
  '吗',
]);

function tokenize(question: string): string[] {
  const normalized = question
    .toLowerCase()
    .replace(/[，。！？；：、,.!?;:()[\]{}"'“”‘’]/g, ' ');
  const raw = normalized.split(/\s+/).filter(Boolean);
  const tokens = raw.flatMap((part) => {
    if (/^[a-z0-9_-]+$/i.test(part)) {
      return [part];
    }
    if (part.length <= 2) {
      return [part];
    }
    const grams: string[] = [part];
    for (let index = 0; index <= part.length - 2; index += 1) {
      grams.push(part.slice(index, index + 2));
    }
    return grams;
  });

  return [...new Set(tokens.filter((token) => token.length > 1 && !STOP_WORDS.has(token)))];
}

function countHits(text: string | null, tokens: string[]): number {
  if (!text) {
    return 0;
  }
  const lower = text.toLowerCase();
  return tokens.filter((token) => lower.includes(token)).length;
}

function makeSnippet(policy: QaPolicyRow, tokens: string[]): string {
  const content = policy.content ?? '';
  const matchedToken = tokens.find((token) => content.toLowerCase().includes(token));
  if (!matchedToken) {
    return policy.title;
  }
  const lower = content.toLowerCase();
  const index = lower.indexOf(matchedToken);
  const start = Math.max(0, index - 40);
  const end = Math.min(content.length, index + matchedToken.length + 80);
  return content.slice(start, end);
}

function scorePolicy(
  policy: QaPolicyRow,
  tokens: string[],
  requestedPolicyId?: string,
): ScoredPolicy {
  const titleHits = countHits(policy.title, tokens);
  const contentHits = countHits(policy.content, tokens);
  const sourceText = `${policy.source_name ?? ''} ${policy.source_url ?? ''}`;
  const sourceHit = countHits(sourceText, tokens) > 0;

  const policyIdScore = requestedPolicyId === policy.policy_id ? 0.3 : 0;
  const titleScore = Math.min(0.5, titleHits * 0.25);
  const contentScore = Math.min(0.3, contentHits * 0.15);
  const sourceScore = sourceHit ? 0.1 : 0;
  const confidence = Math.min(1, policyIdScore + titleScore + contentScore + sourceScore);

  return {
    policy,
    confidence,
    title_hits: titleHits,
    content_hits: contentHits,
    source_hit: sourceHit,
    snippet: makeSnippet(policy, tokens),
  };
}

function answerFromCitation(citation: Citation): string {
  return `根据《${citation.title}》（${citation.version}）可引用内容：${citation.snippet}`;
}

function classifyQaStatus(input: {
  citations: Citation[];
  confidence: number;
}): QaStatus {
  if (input.citations.length === 0) {
    return 'manual_review';
  }
  if (input.confidence >= CONFIDENCE_THRESHOLD) {
    return 'answered';
  }
  if (input.confidence > 0) {
    return 'need_info';
  }
  return 'manual_review';
}

function citationsFromRag(citations: RagCitation[]): Citation[] {
  return citations.map((citation) => ({
    policy_id: citation.policy_id,
    title: citation.title,
    version: citation.version,
    source_name: citation.source_name,
    source_url: citation.source_url,
    snippet: citation.snippet,
  }));
}

async function runLegacyKeywordQa(input: {
  question: string;
  policy_id?: string;
}): Promise<{
  confidence: number;
  citations: Citation[];
  scoring: Record<string, unknown>;
}> {
  const tokens = tokenize(input.question);
  const policies = await listWhitelistedEffectivePolicies({
    policy_id: input.policy_id,
  });

  const scored = policies
    .map((policy) => scorePolicy(policy, tokens, input.policy_id))
    .sort((left, right) => right.confidence - left.confidence);
  const top = scored[0];
  const citations: Citation[] = top && top.confidence > 0
    ? [
        {
          policy_id: top.policy.policy_id,
          title: top.policy.title,
          version: top.policy.version,
          source_name: top.policy.source_name,
          source_url: top.policy.source_url,
          snippet: top.snippet,
        },
      ]
    : [];

  return {
    confidence: top?.confidence ?? 0,
    citations,
    scoring: top
      ? {
          policy_id_exact: input.policy_id === top.policy.policy_id,
          title_hits: top.title_hits,
          content_hits: top.content_hits,
          source_hit: top.source_hit,
          threshold: CONFIDENCE_THRESHOLD,
        }
      : {
          policy_id_exact: false,
          title_hits: 0,
          content_hits: 0,
          source_hit: false,
          threshold: CONFIDENCE_THRESHOLD,
        },
  };
}

export class PolicyQaService {
  async ask(actorId: string, traceId: string, input: PolicyQaRequest) {
    if (!input.question || input.question.trim() === '') {
      throw new ApiError('VALIDATION_ERROR', 'question is required');
    }

    if (loadEnv().agentOrchestrationEnabled) {
      return this.askWithAgentRun(actorId, traceId, input);
    }

    return this.askLegacy(actorId, traceId, input);
  }

  private async askWithAgentRun(
    actorId: string,
    traceId: string,
    input: PolicyQaRequest,
  ) {
    const run = await agentRunService.startRun({
      actor: {
        actor_id: actorId,
        roles: [],
      },
      trace_id: traceId,
      body: {
        entrypoint: 'consultation',
        input: {
          question: input.question,
          policy_id: input.policy_id,
          runtime: policyQaRuntimeInput(input.runtime),
        },
      },
    });

    return policyQaResponseFromAgentRun(run);
  }

  private async askLegacy(actorId: string, traceId: string, input: PolicyQaRequest) {
    let retrievalResult: Pick<RagSearchResult, 'backend_mode' | 'confidence' | 'citations' | 'fallback_task' | 'degrade_reason'>;
    let scoring: Record<string, unknown>;

    const ragResult = await ragService.search(actorId, traceId, {
      query: input.question,
      policy_id: input.policy_id,
      limit: 3,
      create_fallback_task: false,
    });

    retrievalResult = {
      backend_mode: ragResult.backend_mode,
      confidence: ragResult.confidence,
      citations: ragResult.citations,
      fallback_task: null,
      degrade_reason: ragResult.degrade_reason ?? null,
    };
    scoring = {
      threshold: CONFIDENCE_THRESHOLD,
      citation_count: ragResult.citations.length,
      retrieval_backend_mode: ragResult.backend_mode,
    };

    if (ragResult.citations.length === 0) {
      const legacyResult = await runLegacyKeywordQa({
        question: input.question,
        policy_id: input.policy_id,
      });
      if (legacyResult.citations.length > 0) {
        retrievalResult = {
          backend_mode: 'local_fallback',
          confidence: legacyResult.confidence,
          citations: legacyResult.citations.map((citation) => ({
            citation_id: `${citation.policy_id}:${citation.version}:legacy`,
            chunk_id: `${citation.policy_id}:legacy`,
            policy_id: citation.policy_id,
            version: citation.version,
            title: citation.title,
            section_path: 'legacy',
            chunk_order: 1,
            source_name: citation.source_name,
            source_url: citation.source_url,
            snippet: citation.snippet,
            score: legacyResult.confidence,
            status: 'effective',
          })),
          fallback_task: null,
          degrade_reason: ragResult.degrade_reason ?? null,
        };
        scoring = legacyResult.scoring;
      }
    }

    const citations = citationsFromRag(retrievalResult.citations);
    const status = classifyQaStatus({
      citations,
      confidence: retrievalResult.confidence,
    });

    const answer = status === 'answered'
      ? answerFromCitation(citations[0])
      : status === 'need_info'
        ? '当前问题与政策依据存在部分匹配，但置信度不足，无法给出确定政策答案。'
        : '未找到可引用的白名单政策依据，无法给出正式政策答案。';

    await auditService.write({
      actor_id: actorId,
      action: 'policy_qa.ask',
      target_type: 'policy_qa',
      target_id: input.policy_id ?? 'unspecified',
      trace_id: traceId,
      detail: {
        status,
        confidence: retrievalResult.confidence,
        policy_id: citations[0]?.policy_id ?? null,
        retrieval_backend_mode: retrievalResult.backend_mode,
        retrieval_degrade_reason: retrievalResult.degrade_reason ?? null,
        citation_count: citations.length,
      },
    });

    let fallbackTask = retrievalResult.fallback_task;
    if (status === 'manual_review' && !fallbackTask) {
      const fallback = await fallbackService.createIfNotExists({
        actor_id: actorId,
        trace_id: traceId,
        source_type: 'policy_qa',
        source_id: createPolicyQaSourceId({
          actor_id: actorId,
          policy_id: input.policy_id,
          question: input.question,
        }),
        reason: 'policy_qa_manual_review',
        context: {
          normalized_question: normalizeQuestion(input.question),
          policy_id: input.policy_id ?? null,
          confidence: retrievalResult.confidence,
          status,
          citation_count: citations.length,
        },
      });
      fallbackTask = {
        task_id: fallback.task.task_id,
        created: fallback.created,
      };
    }

    return {
      status,
      answer,
      confidence: retrievalResult.confidence,
      citations,
      fallback_task: fallbackTask,
      follow_up_questions: status === 'answered'
        ? []
        : ['请补充企业所属行业、营收、员工数或指定要咨询的政策。'],
      scoring,
    };
  }
}

function policyQaRuntimeInput(runtime: PolicyQaRequest['runtime']) {
  if (runtime?.fanout_mode !== 'parallel') {
    return undefined;
  }
  return {
    fanout_mode: 'parallel' as const,
  };
}

function policyQaResponseFromAgentRun(run: AgentRunRow) {
  if (run.status === 'queued' || run.status === 'running') {
    return {
      status: 'need_info' as QaStatus,
      answer: 'Agent run has been queued. Please poll the run URL for the final answer.',
      confidence: 0,
      citations: [],
      fallback_task: null,
      follow_up_questions: [],
      scoring: {
        agent_orchestration_enabled: true,
        run_id: run.run_id,
        current_node: run.current_node,
        poll_url: `/api/v1/agent-runs/${run.run_id}`,
        async_status: run.status,
      },
    };
  }
  const citations = citationsFromRag(
    (run.state.retrieval?.citations ?? []) as RagCitation[],
  );
  const status: QaStatus = run.status === 'interrupted'
    ? 'manual_review'
    : citations.length > 0
      ? 'answered'
      : 'manual_review';

  return {
    status,
    answer: run.state.final?.answer
      ?? (status === 'answered'
        ? answerFromCitation(citations[0])
        : 'No usable policy citation was found. Manual fallback is required.'),
    confidence: run.state.judge?.confidence
      ?? run.state.policy_analysis?.confidence
      ?? run.state.retrieval?.confidence
      ?? 0,
    citations,
    fallback_task: run.state.fallback
      ? {
          task_id: run.state.fallback.task_id,
          created: true,
        }
      : null,
    follow_up_questions: status === 'answered'
      ? []
      : ['Please provide more policy context or wait for manual fallback.'],
    scoring: {
      agent_orchestration_enabled: true,
      run_id: run.run_id,
      current_node: run.current_node,
      intent: run.state.intent ?? null,
      retrieval_backend_mode: run.state.retrieval?.backend_mode ?? null,
      citation_count: citations.length,
      judge: run.state.judge ?? null,
    },
  };
}

export const policyQaService = new PolicyQaService();
