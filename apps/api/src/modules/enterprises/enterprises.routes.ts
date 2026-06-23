import { type FastifyInstance } from 'fastify';
import { ok } from '../../common/response/api-response.js';
import { requireAuth } from '../auth/auth.middleware.js';
import { enterpriseService, type BindEnterpriseRequest } from './enterprises.service.js';

export async function registerEnterpriseRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: BindEnterpriseRequest }>(
    '/api/v1/enterprises/bind',
    { preHandler: requireAuth },
    async (request) => {
      const actor = request.context.actor;
      if (!actor) {
        throw new Error('actor context is required');
      }

      const result = await enterpriseService.bindEnterprise(
        actor.actor_id,
        request.context.trace_id,
        request.body,
      );

      return ok(result, request.context.trace_id);
    },
  );

  app.get('/api/v1/enterprises/me', { preHandler: requireAuth }, async (request) => {
    const actor = request.context.actor;
    if (!actor) {
      throw new Error('actor context is required');
    }

    return ok(
      await enterpriseService.listMyEnterprises(actor.actor_id),
      request.context.trace_id,
    );
  });
}
