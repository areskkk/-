import { type FastifyInstance } from 'fastify';
import { ok } from '../../common/response/api-response.js';
import { requireAuth } from '../auth/auth.middleware.js';
import { policyQaService, type PolicyQaRequest } from './policy-qa.service.js';

export async function registerPolicyQaRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: PolicyQaRequest }>(
    '/api/v1/policy-qa',
    { preHandler: requireAuth },
    async (request) => {
      const actor = request.context.actor;
      if (!actor) {
        throw new Error('actor context is required');
      }

      return ok(
        await policyQaService.ask(
          actor.actor_id,
          request.context.trace_id,
          request.body,
        ),
        request.context.trace_id,
      );
    },
  );
}
