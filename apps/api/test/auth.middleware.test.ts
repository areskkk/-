import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/common/errors/http-error.js';
import { createRequestContext } from '../src/common/request-context.js';
import {
  parseBearerToken,
  parseDevelopmentStubToken,
  requireAuth,
} from '../src/modules/auth/auth.middleware.js';

describe('auth middleware', () => {
  it('parses bearer tokens', () => {
    expect(parseBearerToken('Bearer token-001')).toBe('token-001');
    expect(parseBearerToken('bearer token-001')).toBe('token-001');
    expect(parseBearerToken('Bearer    token-001')).toBe('token-001');
    expect(parseBearerToken('Basic token-001')).toBeUndefined();
    expect(parseBearerToken(undefined)).toBeUndefined();
  });

  it('parses development stub tokens only', () => {
    expect(parseDevelopmentStubToken('dev:user_001:system_admin,policy_admin')).toEqual({
      actor_id: 'user_001',
      roles: ['system_admin', 'policy_admin'],
    });
    expect(parseDevelopmentStubToken('token-001')).toBeUndefined();
  });

  it('requires bearer token', async () => {
    const request = {
      headers: {},
      context: createRequestContext(),
    };

    await expect(requireAuth(request as never, {} as never)).rejects.toBeInstanceOf(ApiError);
  });

  it('rejects non-jwt bearer tokens when development stub auth is disabled', async () => {
    process.env.ALLOW_DEV_STUB_AUTH = 'false';
    const request = {
      headers: {
        authorization: 'Bearer token-001',
      },
      context: createRequestContext(),
    };

    await expect(requireAuth(request as never, {} as never)).rejects.toBeInstanceOf(ApiError);
  });

  it('injects actor context for development stub token only when explicitly enabled', async () => {
    process.env.ALLOW_DEV_STUB_AUTH = 'true';
    const request = {
      headers: {
        authorization: 'Bearer dev:user_001:system_admin',
      },
      context: createRequestContext(),
    };

    await requireAuth(request as never, {} as never);

    expect(request.context.actor).toEqual({
      actor_id: 'user_001',
      roles: ['system_admin'],
      auth_type: 'development_stub',
      user_type: 'development_stub',
    });

    process.env.ALLOW_DEV_STUB_AUTH = 'false';
  });
});
