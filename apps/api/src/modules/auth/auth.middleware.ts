import { type FastifyReply, type FastifyRequest } from 'fastify';
import { loadEnv } from '../../config/env.js';
import { ApiError } from '../../common/errors/http-error.js';
import { type JwtClaims } from './auth.types.js';

export function parseBearerToken(authorization?: string): string | undefined {
  if (!authorization) {
    return undefined;
  }

  const [scheme, token] = authorization.trim().split(/\s+/);
  if (scheme?.toLowerCase() !== 'bearer' || !token) {
    return undefined;
  }

  return token;
}

export type DevelopmentStubToken = {
  actor_id: string;
  roles: string[];
};

// Batch 1 hotfix: this is explicitly development stub auth, not JWT/session auth.
// Accepted token format: dev:<actor_id>:<role>[,<role>]
export function parseDevelopmentStubToken(
  token: string,
): DevelopmentStubToken | undefined {
  const [prefix, actorId, roleList] = token.split(':');
  if (prefix !== 'dev' || !actorId || !roleList) {
    return undefined;
  }

  const roles = roleList
    .split(',')
    .map((role) => role.trim())
    .filter(Boolean);

  if (roles.length === 0) {
    return undefined;
  }

  return {
    actor_id: actorId,
    roles,
  };
}

function applyActorContext(
  request: FastifyRequest,
  input: {
    actor_id: string;
    roles: string[];
    auth_type: 'jwt' | 'development_stub';
    user_type?: string;
  },
): void {
  request.context.actor = {
    actor_id: input.actor_id,
    roles: input.roles,
    auth_type: input.auth_type,
    user_type: input.user_type,
  };
}

function applyJwtActorContext(request: FastifyRequest, claims: JwtClaims): void {
  applyActorContext(request, {
    actor_id: claims.sub,
    roles: claims.roles,
    auth_type: 'jwt',
    user_type: claims.user_type,
  });
}

export async function requireAuth(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  const token = parseBearerToken(request.headers.authorization);
  if (!token) {
    throw new ApiError('AUTH_REQUIRED', 'Bearer token is required');
  }

  try {
    const claims = await request.jwtVerify<JwtClaims>();
    applyJwtActorContext(request, claims);
    return;
  } catch {
    const env = loadEnv();
    if (!env.allowDevStubAuth) {
      throw new ApiError('AUTH_REQUIRED', 'invalid or expired token');
    }
  }

  const actor = parseDevelopmentStubToken(token);
  if (!actor) {
    throw new ApiError('AUTH_REQUIRED', 'invalid or expired token');
  }

  // Development-only fallback. This is not formal JWT/session authentication.
  applyActorContext(request, {
    actor_id: actor.actor_id,
    roles: actor.roles,
    auth_type: 'development_stub',
    user_type: 'development_stub',
  });
}
