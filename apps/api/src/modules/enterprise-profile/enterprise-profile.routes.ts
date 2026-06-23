import { type FastifyInstance } from 'fastify';
import { ok } from '../../common/response/api-response.js';
import { requireAuth } from '../auth/auth.middleware.js';
import {
  enterpriseProfileService,
  type EnterpriseProfilePayload,
} from './enterprise-profile.service.js';

export async function registerEnterpriseProfileRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.get('/api/v1/enterprise-profile', { preHandler: requireAuth }, async (request) => {
    const actor = request.context.actor;
    if (!actor) {
      throw new Error('actor context is required');
    }

    return ok(
      await enterpriseProfileService.getCurrentProfile(actor.actor_id),
      request.context.trace_id,
    );
  });

  app.put<{ Body: EnterpriseProfilePayload }>(
    '/api/v1/enterprise-profile',
    { preHandler: requireAuth },
    async (request) => {
      const actor = request.context.actor;
      if (!actor) {
        throw new Error('actor context is required');
      }

      const result = await enterpriseProfileService.upsertCurrentProfile(
        actor.actor_id,
        request.context.trace_id,
        request.body,
      );

      return ok(result, request.context.trace_id);
    },
  );
}
