import { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { ApiError } from '../../common/errors/http-error.js';
import { ok } from '../../common/response/api-response.js';
import { requireAuth } from '../auth/auth.middleware.js';
import { agentRunService } from '../agents/agents.service.js';
import { permissionService } from '../permission/permission.service.js';
import {
  reviewService,
  type HandleReviewAgentDraftRequest,
  type ReviewDecisionRequest,
  type ReviewPrecheckRequest,
  type SupplementRequest,
} from './review.service.js';

type ListReviewTaskQuery = {
  page?: number | string;
  page_size?: number | string;
  status?: string;
};

function requireReviewPermission(action: string) {
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
      resource: 'review.tasks',
    });

    if (!allowed) {
      throw new ApiError('FORBIDDEN', 'Review permission is required');
    }
  };
}

export async function registerReviewRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: ListReviewTaskQuery }>(
    '/api/v1/review/tasks',
    { preHandler: [requireAuth, requireReviewPermission('review.tasks.list')] },
    async (request) => {
      return ok(await reviewService.listTasks(request.query), request.context.trace_id);
    },
  );

  app.get<{ Params: { item_id: string } }>(
    '/api/v1/review/tasks/:item_id',
    { preHandler: [requireAuth, requireReviewPermission('review.tasks.detail')] },
    async (request) => {
      return ok(
        await reviewService.getTaskDetail(request.params.item_id),
        request.context.trace_id,
      );
    },
  );

  app.post<{ Params: { item_id: string }; Body: ReviewDecisionRequest }>(
    '/api/v1/review/tasks/:item_id/decision',
    { preHandler: [requireAuth, requireReviewPermission('review.tasks.decision')] },
    async (request) => {
      const actor = request.context.actor;
      if (!actor) {
        throw new Error('actor context is required');
      }

      return ok(
        await reviewService.decide(
          actor.actor_id,
          request.context.trace_id,
          request.params.item_id,
          request.body,
        ),
        request.context.trace_id,
      );
    },
  );

  app.post<{ Params: { item_id: string }; Body: ReviewPrecheckRequest }>(
    '/api/v1/review/tasks/:item_id/precheck',
    { preHandler: [requireAuth, requireReviewPermission('review.tasks.decision')] },
    async (request) => {
      const actor = request.context.actor;
      if (!actor) {
        throw new Error('actor context is required');
      }

      return ok(
        await reviewService.precheck(
          actor.actor_id,
          request.context.trace_id,
          request.params.item_id,
          request.body ?? {},
        ),
        request.context.trace_id,
      );
    },
  );

  app.post<{ Params: { item_id: string }; Body: SupplementRequest }>(
    '/api/v1/review/tasks/:item_id/supplement-request',
    { preHandler: [requireAuth, requireReviewPermission('review.tasks.decision')] },
    async (request) => {
      const actor = request.context.actor;
      if (!actor) {
        throw new Error('actor context is required');
      }

      return ok(
        await reviewService.requestSupplement(
          actor.actor_id,
          request.context.trace_id,
          request.params.item_id,
          request.body,
        ),
        request.context.trace_id,
      );
    },
  );

  app.post<{
    Params: { item_id: string };
    Body: { idempotency_key?: string };
  }>(
    '/api/v1/review/tasks/:item_id/agent-draft',
    { preHandler: [requireAuth, requireReviewPermission('review.tasks.decision')] },
    async (request) => {
      const actor = request.context.actor;
      if (!actor) {
        throw new Error('actor context is required');
      }

      return ok(
        await agentRunService.startRun({
          actor: {
            actor_id: actor.actor_id,
            roles: actor.roles,
            user_type: actor.user_type,
          },
          trace_id: request.context.trace_id,
          body: {
            entrypoint: 'review',
            input: {
              item_id: request.params.item_id,
            },
            idempotency_key: request.body?.idempotency_key,
          },
        }),
        request.context.trace_id,
      );
    },
  );

  app.post<{ Params: { draft_id: string }; Body: HandleReviewAgentDraftRequest }>(
    '/api/v1/review/agent-drafts/:draft_id/handle',
    { preHandler: [requireAuth, requireReviewPermission('review.tasks.decision')] },
    async (request) => {
      const actor = request.context.actor;
      if (!actor) {
        throw new Error('actor context is required');
      }

      return ok(
        await reviewService.handleAgentDraft(
          actor.actor_id,
          request.context.trace_id,
          request.params.draft_id,
          request.body,
        ),
        request.context.trace_id,
      );
    },
  );
}
