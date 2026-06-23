import Fastify, { type FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import fastifyMultipart from '@fastify/multipart';
import { createRequestContext } from './common/request-context.js';
import { errorResponse } from './common/response/api-response.js';
import { ApiError } from './common/errors/http-error.js';
import { loadEnv } from './config/env.js';
import { registerRoutes } from './routes.js';
import { agentRunWorker } from './modules/agents/runtime/agent-run-worker.js';
import { ocrJobWorker } from './modules/ocr/ocr-job-worker.js';

export async function buildApp(): Promise<FastifyInstance> {
  const env = loadEnv();
  const app = Fastify({
    logger: true,
  });

  await app.register(fastifyJwt, {
    secret: env.jwtSecret,
  });

  await app.register(fastifyMultipart, {
    limits: {
      fileSize: env.fileUploadMaxBytes,
      files: 1,
    },
  });

  app.addHook('onRequest', async (request) => {
    request.context = createRequestContext();
  });

  app.setErrorHandler((error, request, reply) => {
    const traceId = request.context?.trace_id;

    if (error instanceof ApiError) {
      reply
        .status(error.statusCode)
        .send(errorResponse(error.code, error.message, error.details, traceId));
      return;
    }

    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'FST_REQ_FILE_TOO_LARGE'
    ) {
      reply
        .status(400)
        .send(errorResponse('VALIDATION_ERROR', 'file size exceeds FILE_UPLOAD_MAX_BYTES', undefined, traceId));
      return;
    }

    request.log.error(error);
    reply
      .status(500)
      .send(errorResponse('INTERNAL_ERROR', 'Internal server error', undefined, traceId));
  });

  await registerRoutes(app);
  if (env.agentRunAsyncEnabled && env.agentRunWorkerAutostart) {
    agentRunWorker.start();
    ocrJobWorker.start();
    app.addHook('onClose', async () => {
      agentRunWorker.stop();
      ocrJobWorker.stop();
    });
  }
  return app;
}
