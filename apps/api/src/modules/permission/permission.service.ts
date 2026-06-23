export type PermissionInput = {
  actor_id: string;
  roles: string[];
  user_type?: string;
  action: string;
  resource: string;
  attributes?: Record<string, unknown>;
};

const ADMIN_ROLES = new Set([
  'system_admin',
  'policy_admin',
  'kb_operator',
  'qa_reviewer',
]);

const REVIEW_READ_ROLES = new Set([
  'window_staff',
  'reviewer',
  'department_lead',
  'system_admin',
]);

const REVIEW_DECISION_ROLES = new Set([
  'reviewer',
  'department_lead',
  'system_admin',
]);

const FALLBACK_LIST_ROLES = new Set([
  'kb_operator',
  'qa_reviewer',
  'system_admin',
]);

const FALLBACK_RESOLVE_ROLES = new Set([
  'kb_operator',
  'system_admin',
]);

const RAG_INDEX_ROLES = new Set([
  'policy_admin',
  'system_admin',
]);

const AGENT_METRICS_READ_ROLES = new Set([
  'system_admin',
  'department_lead',
]);

const AGENT_OPS_UPDATE_ROLES = new Set([
  'system_admin',
]);

const AGENT_APPROVAL_DECIDE_ROLES = new Set([
  'system_admin',
  'department_lead',
]);

export class PermissionService {
  async can(input: PermissionInput): Promise<boolean> {
    if (input.action === 'admin.rag.policies.index') {
      return input.roles.some((role) => RAG_INDEX_ROLES.has(role));
    }

    if (input.action === 'admin.agent.metrics.read') {
      return input.roles.some((role) => AGENT_METRICS_READ_ROLES.has(role));
    }

    if (input.action === 'admin.agent.ops.update') {
      return input.roles.some((role) => AGENT_OPS_UPDATE_ROLES.has(role));
    }

    if (input.action === 'admin.agent.ops.read') {
      return input.roles.some((role) => AGENT_METRICS_READ_ROLES.has(role));
    }

    if (
      input.action === 'admin.agent.approvals.list' ||
      input.action === 'admin.agent.approvals.decide'
    ) {
      return input.roles.some((role) => AGENT_APPROVAL_DECIDE_ROLES.has(role));
    }

    if (
      input.action === 'admin.fallback.tasks.list' ||
      input.action === 'admin.fallback.tasks.detail'
    ) {
      return input.roles.some((role) => FALLBACK_LIST_ROLES.has(role));
    }

    if (input.action === 'admin.fallback.tasks.resolve') {
      return input.roles.some((role) => FALLBACK_RESOLVE_ROLES.has(role));
    }

    if (input.resource.startsWith('admin.')) {
      return input.roles.some((role) => ADMIN_ROLES.has(role));
    }

    if (input.resource.startsWith('review.')) {
      const allowedRoles = input.action.endsWith('.decision')
        ? REVIEW_DECISION_ROLES
        : REVIEW_READ_ROLES;

      return input.roles.some((role) => allowedRoles.has(role));
    }

    if (input.resource.startsWith('enterprise.')) {
      return input.roles.some((role) =>
        ['owner', 'manager', 'operator', 'viewer'].includes(role),
      );
    }

    return true;
  }
}

export const permissionService = new PermissionService();
