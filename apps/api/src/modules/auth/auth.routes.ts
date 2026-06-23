import { type FastifyInstance } from 'fastify';
import { ok } from '../../common/response/api-response.js';
import { authService } from './auth.service.js';
import { auditService } from '../audit/audit.service.js';
import { type LoginRequest, type RegisterRequest, type ResetPasswordRequest } from './auth.types.js';
import { requireAuth } from './auth.middleware.js';

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: RegisterRequest }>('/api/v1/auth/register', async (request) => {
    const user = await authService.register(request.body);
    await auditService.write({
      actor_id: user.user_id,
      action: 'auth.register',
      target_type: 'user',
      target_id: user.user_id,
      trace_id: request.context.trace_id,
      detail: {
        phone: user.phone,
        user_type: user.user_type,
      },
    });

    return ok(
      user,
      request.context.trace_id,
    );
  });

  app.post<{ Body: ResetPasswordRequest }>('/api/v1/auth/reset-password', async (request) => {
    const result = await authService.resetPassword(request.body);
    await auditService.write({
      actor_id: result.user_id,
      action: 'auth.password_reset',
      target_type: 'user',
      target_id: result.user_id,
      trace_id: request.context.trace_id,
      detail: {
        phone: result.phone,
      },
    });

    return ok(
      {
        password_reset: true,
      },
      request.context.trace_id,
    );
  });

  app.post<{ Body: LoginRequest }>('/api/v1/auth/login', async (request) => {
    const user = await authService.login(request.body);
    const token = await app.jwt.sign({
      sub: user.user_id,
      roles: user.roles,
      user_type: user.user_type,
    });

    return ok(
      {
        token,
        user,
      },
      request.context.trace_id,
    );
  });

  app.get('/api/v1/auth/me', {
    preHandler: requireAuth,
  }, async (request) => {
    const actorId = request.context.actor?.actor_id;
    if (!actorId) {
      throw new Error('Authenticated request is missing actor context');
    }

    const user = await authService.getCurrentUser(actorId);
    return ok(user, request.context.trace_id);
  });

  app.post('/api/v1/auth/logout', {
    preHandler: requireAuth,
  }, async (request) => {
    return ok({ logged_out: true }, request.context.trace_id);
  });
}
