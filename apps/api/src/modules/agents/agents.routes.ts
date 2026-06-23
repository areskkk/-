import { type FastifyInstance } from 'fastify';
import { ok } from '../../common/response/api-response.js';
import { requireAuth } from '../auth/auth.middleware.js';
import {
  agentRunService,
} from './agents.service.js';
import {
  type CreateAgentRunRequest,
  type ResumeAgentRunRequest,
} from './agents.types.js';

export async function registerAgentRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: CreateAgentRunRequest }>(
    '/api/v1/agent-runs',
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
          body: request.body,
        }),
        request.context.trace_id,
      );
    },
  );

  app.get<{ Params: { run_id: string } }>(
    '/api/v1/agent-runs/:run_id',
    { preHandler: requireAuth },
    async (request) => {
      const actor = request.context.actor;
      if (!actor) {
        throw new Error('actor context is required');
      }

      return ok(
        await agentRunService.getRun(request.params.run_id, {
          actor_id: actor.actor_id,
          roles: actor.roles,
          user_type: actor.user_type,
        }),
        request.context.trace_id,
      );
    },
  );

  app.get<{ Params: { run_id: string } }>(
    '/api/v1/agent-runs/:run_id/steps',
    { preHandler: requireAuth },
    async (request) => {
      const actor = request.context.actor;
      if (!actor) {
        throw new Error('actor context is required');
      }

      return ok(
        await agentRunService.listSteps(request.params.run_id, {
          actor_id: actor.actor_id,
          roles: actor.roles,
          user_type: actor.user_type,
        }),
        request.context.trace_id,
      );
    },
  );

  app.get<{ Params: { run_id: string } }>(
    '/api/v1/agent-runs/:run_id/action-replay',
    { preHandler: requireAuth },
    async (request) => {
      const actor = request.context.actor;
      if (!actor) {
        throw new Error('actor context is required');
      }

      return ok(
        await agentRunService.getActionReplayTrace(request.params.run_id, {
          actor_id: actor.actor_id,
          roles: actor.roles,
          user_type: actor.user_type,
        }),
        request.context.trace_id,
      );
    },
  );

  app.post<{
    Params: { run_id: string };
    Body: ResumeAgentRunRequest;
  }>(
    '/api/v1/agent-runs/:run_id/resume',
    { preHandler: requireAuth },
    async (request) => {
      const actor = request.context.actor;
      if (!actor) {
        throw new Error('actor context is required');
      }

      return ok(
        await agentRunService.resumeRun({
          actor: {
            actor_id: actor.actor_id,
            roles: actor.roles,
            user_type: actor.user_type,
          },
          trace_id: request.context.trace_id,
          run_id: request.params.run_id,
          body: request.body,
        }),
        request.context.trace_id,
      );
    },
  );

  app.post<{
    Params: { run_id: string };
    Body: { reason?: string };
  }>(
    '/api/v1/agent-runs/:run_id/replay',
    { preHandler: requireAuth },
    async (request) => {
      const actor = request.context.actor;
      if (!actor) {
        throw new Error('actor context is required');
      }

      return ok(
        await agentRunService.replayRun({
          actor: {
            actor_id: actor.actor_id,
            roles: actor.roles,
            user_type: actor.user_type,
          },
          trace_id: request.context.trace_id,
          run_id: request.params.run_id,
          reason: request.body?.reason,
        }),
        request.context.trace_id,
      );
    },
  );
}
