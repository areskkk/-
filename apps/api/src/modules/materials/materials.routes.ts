import { type FastifyInstance } from 'fastify';
import { ok } from '../../common/response/api-response.js';
import { requireAuth } from '../auth/auth.middleware.js';
import {
  materialService,
  type CreateMaterialRequest,
} from './materials.service.js';

export async function registerMaterialRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: CreateMaterialRequest }>(
    '/api/v1/materials',
    { preHandler: requireAuth },
    async (request) => {
      const actor = request.context.actor;
      if (!actor) {
        throw new Error('actor context is required');
      }

      const result = await materialService.create(
        actor.actor_id,
        request.context.trace_id,
        request.body,
      );

      return ok(result, request.context.trace_id);
    },
  );
}
