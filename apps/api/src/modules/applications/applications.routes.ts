import { type FastifyInstance } from 'fastify';
import { ok } from '../../common/response/api-response.js';
import { requireAuth } from '../auth/auth.middleware.js';
import { agentRunService } from '../agents/agents.service.js';
import {
  applicationService,
  type CreateApplicationRequest,
  type SubmitSupplementRequest,
  type WithdrawApplicationRequest,
} from './applications.service.js';

type ListApplicationQuery = {
  enterprise_id: string;
  page?: number;
  page_size?: number;
};

export async function registerApplicationRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: CreateApplicationRequest }>(
    '/api/v1/applications',
    { preHandler: requireAuth },
    async (request) => {
      const actor = request.context.actor;
      if (!actor) {
        throw new Error('actor context is required');
      }

      const result = await applicationService.createDraft(
        actor.actor_id,
        request.context.trace_id,
        request.body,
      );

      return ok(result, request.context.trace_id);
    },
  );

  app.get<{ Querystring: ListApplicationQuery }>(
    '/api/v1/applications',
    { preHandler: requireAuth },
    async (request) => {
      const actor = request.context.actor;
      if (!actor) {
        throw new Error('actor context is required');
      }

      const result = await applicationService.listByEnterprise(
        actor.actor_id,
        request.query.enterprise_id,
        request.query,
      );

      return ok(result, request.context.trace_id);
    },
  );

  app.get<{ Params: { application_id: string } }>(
    '/api/v1/applications/:application_id',
    { preHandler: requireAuth },
    async (request) => {
      const actor = request.context.actor;
      if (!actor) {
        throw new Error('actor context is required');
      }

      const result = await applicationService.getDetail(
        actor.actor_id,
        request.params.application_id,
      );

      return ok(result, request.context.trace_id);
    },
  );

  app.post<{ Params: { application_id: string } }>(
    '/api/v1/applications/:application_id/submit',
    { preHandler: requireAuth },
    async (request) => {
      const actor = request.context.actor;
      if (!actor) {
        throw new Error('actor context is required');
      }

      const result = await applicationService.submit(
        actor.actor_id,
        request.context.trace_id,
        request.params.application_id,
      );

      return ok(result, request.context.trace_id);
    },
  );

  app.post<{
    Params: { application_id: string };
    Body: WithdrawApplicationRequest;
  }>(
    '/api/v1/applications/:application_id/withdraw',
    { preHandler: requireAuth },
    async (request) => {
      const actor = request.context.actor;
      if (!actor) {
        throw new Error('actor context is required');
      }

      const result = await applicationService.withdraw(
        actor.actor_id,
        request.context.trace_id,
        request.params.application_id,
        request.body ?? {},
      );

      return ok(result, request.context.trace_id);
    },
  );

  app.post<{ Params: { application_id: string }; Body: SubmitSupplementRequest }>(
    '/api/v1/applications/:application_id/supplements',
    { preHandler: requireAuth },
    async (request) => {
      const actor = request.context.actor;
      if (!actor) {
        throw new Error('actor context is required');
      }

      const result = await applicationService.submitSupplement(
        actor.actor_id,
        request.context.trace_id,
        request.params.application_id,
        request.body,
      );

      return ok(result, request.context.trace_id);
    },
  );

  app.post<{
    Params: { application_id: string };
    Body: { item_id?: string; idempotency_key?: string };
  }>(
    '/api/v1/applications/:application_id/agent-assist',
    { preHandler: requireAuth },
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
            entrypoint: 'application',
            input: {
              application_id: request.params.application_id,
              ...(request.body?.item_id ? { item_id: request.body.item_id } : {}),
            },
            idempotency_key: request.body?.idempotency_key,
          },
        }),
        request.context.trace_id,
      );
    },
  );
}
