import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';

describe('admin permission chain', () => {
  process.env.ALLOW_DEV_STUB_AUTH = 'true';

  it('rejects admin routes for non-admin development stub roles', async () => {
    const app = await buildApp();

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/audit-logs',
      headers: {
        authorization: 'Bearer dev:user_001:viewer',
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      success: false,
      error: {
        code: 'FORBIDDEN',
      },
    });

    await app.close();
  });
});
