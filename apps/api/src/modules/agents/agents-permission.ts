import { ApiError } from '../../common/errors/http-error.js';
import { findEnterprisesByUserId } from '../enterprises/enterprises.repository.js';
import { permissionService } from '../permission/permission.service.js';
import { findApplicationPolicyEvidence } from '../eligibility/eligibility.repository.js';
import { findFallbackTaskByRun } from '../fallback/fallback.repository.js';
import { findReviewTaskByItemId } from '../review/review.repository.js';
import {
  type AgentGraphState,
  type AgentRunEntrypoint,
  type AgentRunRow,
} from './agents.types.js';
import { isMockEntrypoint } from './runtime/mock-graph-runner.js';

export type AgentActorContext = {
  actor_id: string;
  roles: string[];
  user_type?: string;
};

function hasAdminAgentAccess(actor: AgentActorContext): boolean {
  return actor.roles.some((role) =>
    ['system_admin', 'policy_admin', 'qa_reviewer', 'kb_operator'].includes(role),
  );
}

async function assertEnterpriseAccess(
  actor: AgentActorContext,
  enterpriseId: string,
): Promise<void> {
  if (hasAdminAgentAccess(actor)) {
    return;
  }

  const enterprises = await findEnterprisesByUserId(actor.actor_id);
  const matched = enterprises.some(
    (enterprise) => enterprise.enterprise_id === enterpriseId,
  );
  if (!matched) {
    throw new ApiError('FORBIDDEN', 'agent run business object access is denied');
  }
}

async function assertApplicationAccess(
  actor: AgentActorContext,
  applicationId: string,
): Promise<void> {
  const application = await findApplicationPolicyEvidence(applicationId);
  if (!application) {
    throw new ApiError('NOT_FOUND', 'application not found');
  }
  await assertEnterpriseAccess(actor, application.enterprise_id);
}

async function assertReviewAccess(
  actor: AgentActorContext,
  itemId: string,
  action = 'review.tasks.detail',
): Promise<void> {
  const allowed = await permissionService.can({
    actor_id: actor.actor_id,
    roles: actor.roles,
    user_type: actor.user_type,
    action,
    resource: 'review.tasks',
  });
  if (!allowed) {
    throw new ApiError('FORBIDDEN', 'Review permission is required');
  }

  const task = await findReviewTaskByItemId(itemId);
  if (!task) {
    throw new ApiError('NOT_FOUND', 'review task not found');
  }
}

export async function assertCanStartAgentRun(input: {
  actor: AgentActorContext;
  entrypoint: AgentRunEntrypoint;
  bodyInput: Record<string, unknown>;
  production: boolean;
}): Promise<void> {
  if (isMockEntrypoint(input.entrypoint)) {
    if (input.production || !hasAdminAgentAccess(input.actor)) {
      throw new ApiError('FORBIDDEN', 'mock agent run entrypoints are disabled');
    }
    return;
  }

  if (input.entrypoint === 'consultation') {
    const enterpriseId = input.bodyInput.enterprise_id;
    if (typeof enterpriseId === 'string' && enterpriseId.trim() !== '') {
      await assertEnterpriseAccess(input.actor, enterpriseId.trim());
    }
    return;
  }

  if (input.entrypoint === 'application') {
    const applicationId = input.bodyInput.application_id;
    if (typeof applicationId !== 'string' || applicationId.trim() === '') {
      throw new ApiError('VALIDATION_ERROR', 'application_id is required');
    }
    await assertApplicationAccess(input.actor, applicationId.trim());
    return;
  }

  if (input.entrypoint === 'review') {
    const itemId = input.bodyInput.item_id;
    if (typeof itemId !== 'string' || itemId.trim() === '') {
      throw new ApiError('VALIDATION_ERROR', 'item_id is required');
    }
    await assertReviewAccess(input.actor, itemId.trim(), 'review.tasks.decision');
  }
}

export async function assertCanReadAgentRun(input: {
  actor: AgentActorContext;
  run: AgentRunRow;
}): Promise<void> {
  if (input.run.actor_id === input.actor.actor_id || hasAdminAgentAccess(input.actor)) {
    return;
  }

  await assertStateBusinessAccess(input.actor, input.run.state);
}

async function assertStateBusinessAccess(
  actor: AgentActorContext,
  state: AgentGraphState,
): Promise<void> {
  if (state.entrypoint === 'application') {
    const applicationId = state.input.application_id;
    if (typeof applicationId === 'string' && applicationId.trim() !== '') {
      await assertApplicationAccess(actor, applicationId.trim());
      return;
    }
  }

  if (state.entrypoint === 'review') {
    const itemId = state.input.item_id;
    if (typeof itemId === 'string' && itemId.trim() !== '') {
      await assertReviewAccess(actor, itemId.trim());
      return;
    }
  }

  throw new ApiError('FORBIDDEN', 'agent run access is denied');
}

export async function assertCanResumeAgentRun(input: {
  actor: AgentActorContext;
  run: AgentRunRow;
  task_id: string;
}): Promise<void> {
  await assertCanReadAgentRun({
    actor: input.actor,
    run: input.run,
  });

  const fallbackTask = await findFallbackTaskByRun({
    task_id: input.task_id,
    run_id: input.run.run_id,
  });
  if (!fallbackTask) {
    throw new ApiError('NOT_FOUND', 'fallback task not found for agent run');
  }

  if (fallbackTask.status !== 'resolved' && fallbackTask.status !== 'closed') {
    throw new ApiError(
      'CONFLICT',
      'fallback task must be resolved before resuming agent run',
    );
  }

  if (hasAdminAgentAccess(input.actor)) {
    return;
  }

  if (input.run.entrypoint === 'application') {
    await assertStateBusinessAccess(input.actor, input.run.state);
    return;
  }

  if (input.run.entrypoint === 'review') {
    await assertStateBusinessAccess(input.actor, input.run.state);
    return;
  }

  if (input.run.actor_id !== input.actor.actor_id) {
    throw new ApiError('FORBIDDEN', 'agent run resume access is denied');
  }
}
