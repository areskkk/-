import { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { ApiError } from '../../common/errors/http-error.js';
import { ok } from '../../common/response/api-response.js';
import { requireAuth } from '../auth/auth.middleware.js';
import {
  adminService,
  type EnterpriseProfileImportRequest,
} from './admin.service.js';
import { permissionService } from '../permission/permission.service.js';
import {
  fallbackService,
} from '../fallback/fallback.service.js';
import { type ResolveFallbackTaskInput } from '../fallback/fallback.types.js';
import { policyService, type PolicyImportRequest, type PolicySchemaRequest } from '../policies/policies.service.js';
import { ragService } from '../rag/rag.service.js';
import { loadEnv } from '../../config/env.js';
import { type AgentToolName } from '../agents/tools/tool.types.js';

type ListAuditLogQuery = {
  page?: number;
  page_size?: number;
};

type ListFallbackTaskQuery = {
  page?: number | string;
  page_size?: number | string;
  status?: string;
  source_type?: string;
};

type ListAgentRunQuery = {
  page?: number | string;
  page_size?: number | string;
  status?: string;
  trace_id?: string;
};

type ListApprovalQuery = {
  status?: string;
};

type KillSwitchBody = {
  enabled: boolean;
  scope?: 'all' | 'run_creation' | 'llm' | 'tool' | 'resume';
  reason?: string;
};

type SlaGateQuery = {
  max_failed_rate?: number | string;
  max_interrupted_rate?: number | string;
  max_fallback_overdue_count?: number | string;
  max_queue_depth?: number | string;
};

type CapabilityQuery = {
  tenant_id?: string;
  allowed_agents?: string;
  allowed_tools?: string;
  plugin_allowlist?: string;
};

type WorkflowSlaBody = {
  now?: string;
  limit?: number;
};

function requireAdminPermission(action: string) {
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const actor = request.context.actor;
    if (!actor) {
      throw new ApiError('AUTH_REQUIRED', 'Bearer token is required');
    }

    const allowed = await permissionService.can({
      actor_id: actor.actor_id,
      roles: actor.roles,
      user_type: actor.user_type,
      action,
      resource: 'admin.routes',
    });

    if (!allowed) {
      throw new ApiError('FORBIDDEN', 'Admin permission is required');
    }
  };
}

function readAgentToolName(value: string): AgentToolName {
  if (
    value === 'rag.search' ||
    value === 'ocr.material_evidence.read' ||
    value === 'eligibility.rule_engine.check'
  ) {
    return value;
  }
  throw new ApiError('VALIDATION_ERROR', 'invalid agent tool name');
}

function readOptionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readCsv(value: unknown): string[] | undefined {
  if (typeof value !== 'string' || value.trim() === '') {
    return undefined;
  }
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export async function registerAdminRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: PolicyImportRequest }>(
    '/api/v1/admin/policies/import',
    { preHandler: [requireAuth, requireAdminPermission('admin.policies.import')] },
    async (request) => {
      const actor = request.context.actor;
      if (!actor) {
        throw new Error('actor context is required');
      }

      return ok(
        await policyService.importPolicy(
          actor.actor_id,
          request.context.trace_id,
          request.body,
        ),
        request.context.trace_id,
      );
    },
  );

  app.post<{ Body: EnterpriseProfileImportRequest }>(
    '/api/v1/admin/enterprise-profiles/import',
    { preHandler: [requireAuth, requireAdminPermission('admin.enterprise_profiles.import')] },
    async (request) => {
      const actor = request.context.actor;
      if (!actor) {
        throw new Error('actor context is required');
      }

      return ok(
        await adminService.importEnterpriseProfiles(
          actor.actor_id,
          request.context.trace_id,
          request.body,
        ),
        request.context.trace_id,
      );
    },
  );

  app.put<{ Params: { policy_id: string }; Body: PolicySchemaRequest }>(
    '/api/v1/admin/policies/:policy_id/schema',
    { preHandler: [requireAuth, requireAdminPermission('admin.policies.schema.update')] },
    async (request) => {
      const actor = request.context.actor;
      if (!actor) {
        throw new Error('actor context is required');
      }

      return ok(
        await policyService.updatePolicySchema(
          actor.actor_id,
          request.context.trace_id,
          request.params.policy_id,
          request.body,
        ),
        request.context.trace_id,
      );
    },
  );

  app.post<{ Params: { policy_id: string } }>(
    '/api/v1/admin/policies/:policy_id/publish',
    { preHandler: [requireAuth, requireAdminPermission('admin.policies.publish')] },
    async (request) => {
      const actor = request.context.actor;
      if (!actor) {
        throw new Error('actor context is required');
      }

      return ok(
        await policyService.publishPolicy(
          actor.actor_id,
          request.context.trace_id,
          request.params.policy_id,
        ),
        request.context.trace_id,
      );
    },
  );

  app.post<{ Params: { policy_id: string } }>(
    '/api/v1/admin/rag/policies/:policy_id/index',
    { preHandler: [requireAuth, requireAdminPermission('admin.rag.policies.index')] },
    async (request) => {
      const actor = request.context.actor;
      if (!actor) {
        throw new Error('actor context is required');
      }

      return ok(
        await ragService.syncPolicyChunks(
          actor.actor_id,
          request.context.trace_id,
          request.params.policy_id,
        ),
        request.context.trace_id,
      );
    },
  );

  app.get<{ Querystring: ListAuditLogQuery }>(
    '/api/v1/admin/audit-logs',
    { preHandler: [requireAuth, requireAdminPermission('admin.audit.logs.list')] },
    async (request) => {
      return ok(
        await adminService.listAuditLogs(request.query),
        request.context.trace_id,
      );
    },
  );

  app.get<{ Querystring: ListFallbackTaskQuery }>(
    '/api/v1/admin/fallback-tasks',
    { preHandler: [requireAuth, requireAdminPermission('admin.fallback.tasks.list')] },
    async (request) => {
      return ok(
        await fallbackService.list(request.query),
        request.context.trace_id,
      );
    },
  );

  app.get<{ Querystring: ListAgentRunQuery }>(
    '/api/v1/admin/agent-runs',
    { preHandler: [requireAuth, requireAdminPermission('admin.agent.runs.list')] },
    async (request) => {
      return ok(
        await adminService.listAgentRuns(request.query),
        request.context.trace_id,
      );
    },
  );

  app.get<{ Params: { run_id: string } }>(
    '/api/v1/admin/agent-runs/:run_id',
    { preHandler: [requireAuth, requireAdminPermission('admin.agent.runs.detail')] },
    async (request) => {
      return ok(
        await adminService.getAgentRunDetail(request.params.run_id),
        request.context.trace_id,
      );
    },
  );

  app.get<{ Params: { run_id: string } }>(
    '/api/v1/admin/agent-runs/:run_id/action-replay',
    { preHandler: [requireAuth, requireAdminPermission('admin.agent.metrics.read')] },
    async (request) => {
      return ok(
        await adminService.getAgentRunActionReplay(request.params.run_id),
        request.context.trace_id,
      );
    },
  );

  app.get(
    '/api/v1/admin/agent-metrics',
    { preHandler: [requireAuth, requireAdminPermission('admin.agent.metrics.read')] },
    async (request) => {
      return ok(
        await adminService.getAgentMetrics({
          fallback_sla_minutes: loadEnv().agentFallbackSlaMinutes,
        }),
        request.context.trace_id,
      );
    },
  );

  app.get<{ Querystring: SlaGateQuery }>(
    '/api/v1/admin/agent-sla-gate',
    { preHandler: [requireAuth, requireAdminPermission('admin.agent.metrics.read')] },
    async (request) => {
      return ok(
        await adminService.getAgentSlaGate({
          max_failed_rate: readOptionalNumber(request.query.max_failed_rate),
          max_interrupted_rate: readOptionalNumber(request.query.max_interrupted_rate),
          max_fallback_overdue_count: readOptionalNumber(request.query.max_fallback_overdue_count),
          max_queue_depth: readOptionalNumber(request.query.max_queue_depth),
        }),
        request.context.trace_id,
      );
    },
  );

  app.get<{ Querystring: CapabilityQuery }>(
    '/api/v1/admin/agent-capabilities',
    { preHandler: [requireAuth, requireAdminPermission('admin.agent.metrics.read')] },
    async (request) => {
      return ok(
        await adminService.discoverAgentCapabilities({
          tenant_id: request.query.tenant_id,
          allowed_agents: readCsv(request.query.allowed_agents),
          allowed_tools: readCsv(request.query.allowed_tools),
          plugin_allowlist: readCsv(request.query.plugin_allowlist),
        }),
        request.context.trace_id,
      );
    },
  );

  app.get<{ Querystring: CapabilityQuery }>(
    '/api/v1/admin/agent-plugins',
    { preHandler: [requireAuth, requireAdminPermission('admin.agent.metrics.read')] },
    async (request) => {
      return ok(
        await adminService.listAgentPlugins({
          tenant_id: request.query.tenant_id,
          plugin_allowlist: readCsv(request.query.plugin_allowlist),
        }),
        request.context.trace_id,
      );
    },
  );

  app.post<{ Body: WorkflowSlaBody }>(
    '/api/v1/admin/agent-workflows/sla-scan',
    { preHandler: [requireAuth, requireAdminPermission('admin.agent.ops.update')] },
    async (request) => {
      const actor = request.context.actor;
      if (!actor) {
        throw new Error('actor context is required');
      }
      return ok(
        await adminService.scanWorkflowSla({
          actor_id: actor.actor_id,
          trace_id: request.context.trace_id,
          now: request.body?.now,
          limit: request.body?.limit,
        }),
        request.context.trace_id,
      );
    },
  );

  app.get(
    '/api/v1/admin/agent-costs',
    { preHandler: [requireAuth, requireAdminPermission('admin.agent.metrics.read')] },
    async (request) => {
      return ok(
        await adminService.getAgentCostDashboard(),
        request.context.trace_id,
      );
    },
  );

  app.get(
    '/api/v1/admin/agent-ops-controls',
    { preHandler: [requireAuth, requireAdminPermission('admin.agent.ops.read')] },
    async (request) => {
      return ok(
        await adminService.getAgentOpsControls(),
        request.context.trace_id,
      );
    },
  );

  app.put<{ Body: KillSwitchBody }>(
    '/api/v1/admin/agent-ops-controls/kill-switch',
    { preHandler: [requireAuth, requireAdminPermission('admin.agent.ops.update')] },
    async (request) => {
      const actor = request.context.actor;
      if (!actor) {
        throw new Error('actor context is required');
      }
      return ok(
        await adminService.setAgentKillSwitch({
          actor_id: actor.actor_id,
          trace_id: request.context.trace_id,
          body: request.body,
        }),
        request.context.trace_id,
      );
    },
  );

  app.get<{ Querystring: ListApprovalQuery }>(
    '/api/v1/admin/agent-approvals',
    { preHandler: [requireAuth, requireAdminPermission('admin.agent.approvals.list')] },
    async (request) => {
      return ok(
        await adminService.listAgentApprovalRequests(request.query),
        request.context.trace_id,
      );
    },
  );

  app.post<{
    Params: { run_id: string; approval_id: string };
    Body: { status: 'approved' | 'rejected'; comment?: string };
  }>(
    '/api/v1/admin/agent-runs/:run_id/approvals/:approval_id/decision',
    { preHandler: [requireAuth, requireAdminPermission('admin.agent.approvals.decide')] },
    async (request) => {
      const actor = request.context.actor;
      if (!actor) {
        throw new Error('actor context is required');
      }
      return ok(
        await adminService.decideAgentApproval({
          actor_id: actor.actor_id,
          trace_id: request.context.trace_id,
          run_id: request.params.run_id,
          approval_id: request.params.approval_id,
          body: request.body,
        }),
        request.context.trace_id,
      );
    },
  );

  app.post<{ Params: { tool_name: string } }>(
    '/api/v1/admin/agent-tools/:tool_name/circuit/reset',
    { preHandler: [requireAuth, requireAdminPermission('admin.agent.ops.update')] },
    async (request) => {
      const actor = request.context.actor;
      if (!actor) {
        throw new Error('actor context is required');
      }
      return ok(
        await adminService.resetAgentToolCircuit({
          actor_id: actor.actor_id,
          trace_id: request.context.trace_id,
          tool_name: readAgentToolName(request.params.tool_name),
        }),
        request.context.trace_id,
      );
    },
  );

  app.get<{ Params: { task_id: string } }>(
    '/api/v1/admin/fallback-tasks/:task_id',
    { preHandler: [requireAuth, requireAdminPermission('admin.fallback.tasks.detail')] },
    async (request) => {
      return ok(
        await fallbackService.getDetail(request.params.task_id),
        request.context.trace_id,
      );
    },
  );

  app.post<{
    Params: { task_id: string };
    Body: ResolveFallbackTaskInput;
  }>(
    '/api/v1/admin/fallback-tasks/:task_id/resolve',
    { preHandler: [requireAuth, requireAdminPermission('admin.fallback.tasks.resolve')] },
    async (request) => {
      const actor = request.context.actor;
      if (!actor) {
        throw new Error('actor context is required');
      }

      return ok(
        await fallbackService.resolve(
          actor.actor_id,
          request.context.trace_id,
          request.params.task_id,
          request.body,
        ),
        request.context.trace_id,
      );
    },
  );
}
