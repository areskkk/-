import 'fastify';
import { type FastifyJWT } from '@fastify/jwt';
import { type RequestContext } from '../common/request-context.js';
import { type JwtClaims } from '../modules/auth/auth.types.js';

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: JwtClaims;
    user: JwtClaims;
  }
}

declare module 'fastify' {
  interface FastifyRequest {
    context: RequestContext;
  }
}
