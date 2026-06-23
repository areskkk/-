import { type FastifyInstance } from 'fastify';
import { ok } from '../../common/response/api-response.js';
import { requireAuth } from '../auth/auth.middleware.js';
import { ocrService, type StartOcrRequest } from './ocr.service.js';

export async function registerOcrRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { material_id: string }; Body: StartOcrRequest }>(
    '/api/v1/materials/:material_id/ocr',
    { preHandler: requireAuth },
    async (request) => {
      const actor = request.context.actor;
      if (!actor) {
        throw new Error('actor context is required');
      }

      return ok(
        await ocrService.analyze(
          actor.actor_id,
          request.context.trace_id,
          request.params.material_id,
          request.body,
        ),
        request.context.trace_id,
      );
    },
  );

  app.get<{ Params: { material_id: string } }>(
    '/api/v1/materials/:material_id/ocr',
    { preHandler: requireAuth },
    async (request) => {
      const actor = request.context.actor;
      if (!actor) {
        throw new Error('actor context is required');
      }

      return ok(
        await ocrService.getLatest(actor.actor_id, request.params.material_id),
        request.context.trace_id,
      );
    },
  );
}
