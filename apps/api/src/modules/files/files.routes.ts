import { type FastifyInstance } from 'fastify';
import { ok } from '../../common/response/api-response.js';
import { ApiError } from '../../common/errors/http-error.js';
import { requireAuth } from '../auth/auth.middleware.js';
import { fileService } from './files.service.js';

export async function registerFileRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/v1/files', { preHandler: requireAuth }, async (request) => {
    const actor = request.context.actor;
    if (!actor) {
      throw new Error('actor context is required');
    }

    if (!request.isMultipart()) {
      throw new ApiError('VALIDATION_ERROR', 'multipart/form-data is required');
    }

    const data = await request.file();
    if (!data) {
      throw new ApiError('VALIDATION_ERROR', 'file is required');
    }

    const enterpriseIdField = data.fields.enterprise_id;
    const enterpriseId =
      enterpriseIdField && 'value' in enterpriseIdField
        ? String(enterpriseIdField.value)
        : '';
    const purposeField = data.fields.purpose;
    const purpose =
      purposeField && 'value' in purposeField
        ? String(purposeField.value)
        : undefined;

    const result = await fileService.upload({
      actor_id: actor.actor_id,
      trace_id: request.context.trace_id,
      enterprise_id: enterpriseId || undefined,
      purpose,
      file: data,
    });

    return ok(result, request.context.trace_id);
  });
}
