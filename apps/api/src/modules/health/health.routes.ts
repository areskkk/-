import { type FastifyInstance } from 'fastify';
import { ok } from '../../common/response/api-response.js';
import { queryOne } from '../../db/query.js';

export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async (request) => {
    return ok(
      {
        status: 'ok',
        service: 'nankang-zhuqibao-api',
      },
      request.context.trace_id,
    );
  });

  app.get('/health/live', async (request) => {
    return ok(
      {
        status: 'ok',
        service: 'nankang-zhuqibao-api',
      },
      request.context.trace_id,
    );
  });

  app.get('/health/ready', async (request, reply) => {
    try {
      const db = await queryOne<{ ok: number }>('SELECT 1 AS ok');
      const jobs = await queryOne<{ ok: number }>(
        'SELECT 1 AS ok FROM information_schema.tables WHERE table_name = $1',
        ['agent_run_jobs'],
      );
      const ready = Boolean(db?.ok && jobs?.ok);
      if (!ready) {
        reply.status(503);
      }
      return ok(
        {
          status: ready ? 'ok' : 'not_ready',
          checks: {
            database: db?.ok ? 'ok' : 'not_ready',
            agent_run_jobs: jobs?.ok ? 'ok' : 'missing',
          },
        },
        request.context.trace_id,
      );
    } catch (error) {
      reply.status(503);
      return ok(
        {
          status: 'not_ready',
          checks: {
            database: 'not_ready',
            error: error instanceof Error ? error.name : 'unknown_error',
          },
        },
        request.context.trace_id,
      );
    }
  });
}
