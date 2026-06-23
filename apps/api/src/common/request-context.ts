import { randomUUID } from 'node:crypto';

export type ActorContext = {
  actor_id: string;
  roles: string[];
  auth_type: 'jwt' | 'development_stub';
  user_type?: string;
};

export type RequestContext = {
  trace_id: string;
  actor?: ActorContext;
};

export function createRequestContext(): RequestContext {
  return {
    trace_id: randomUUID(),
  };
}
