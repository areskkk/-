import { type FastifyInstance } from 'fastify';
import { ok } from '../../common/response/api-response.js';
import { requireAuth } from '../auth/auth.middleware.js';
import {
  eligibilityService,
  type EligibilityCheckRequest,
} from './eligibility.service.js';

export async function registerEligibilityRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: EligibilityCheckRequest }>(
    '/api/v1/eligibility/check',
    { preHandler: requireAuth },
    async (request) => {
      const actor = request.context.actor;
      if (!actor) {
        throw new Error('actor context is required');
      }

      return ok(
        await eligibilityService.check(
          actor.actor_id,
          request.context.trace_id,
          request.body,
        ),
        request.context.trace_id,
      );
    },
  );
}
