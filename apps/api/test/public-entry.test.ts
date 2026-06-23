import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import {
  canConnectDatabase,
  prepareDatabase,
  truncateBusinessTables,
} from './db-test-utils.js';

const canRunDb = await canConnectDatabase();
const describeIfDb = canRunDb ? describe : describe.skip;

describeIfDb('public entry frontend and auth session', () => {
  beforeAll(async () => {
    await prepareDatabase();
  });

  beforeEach(async () => {
    await truncateBusinessTables();
  });

  it('serves the public entry shell on direct page refresh', async () => {
    const app = await buildApp();

    const loginPage = await app.inject({
      method: 'GET',
      url: '/login',
    });
    expect(loginPage.statusCode).toBe(200);
    expect(loginPage.headers['content-type']).toContain('text/html');
    expect(loginPage.body).toContain('家助宝公共入口');

    const script = await app.inject({
      method: 'GET',
      url: '/app.js',
    });
    expect(script.statusCode).toBe(200);
    expect(script.headers['content-type']).toContain('text/javascript');

    const businessPage = await app.inject({
      method: 'GET',
      url: '/enterprise/dashboard',
    });
    expect(businessPage.statusCode).toBe(200);
    expect(businessPage.body).toContain('家助宝公共入口');

    await app.close();
  });

  it('returns current user, roles and enterprise binding summary', async () => {
    const app = await buildApp();

    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        name: '公共入口用户',
        phone: '13800009991',
        password: 'secret123',
      },
    });

    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: {
        phone: '13800009991',
        password: 'secret123',
      },
    });
    const token = login.json().data.token as string;

    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: {
        authorization: `Bearer ${token}`,
      },
    });

    expect(me.statusCode).toBe(200);
    expect(me.json().data.name).toBe('公共入口用户');
    expect(me.json().data.roles).toContain('viewer');
    expect(me.json().data.has_bound_enterprise).toBe(false);

    await app.close();
  });

  it('registers government and admin account roles for public entry selection', async () => {
    const app = await buildApp();

    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        name: '政府审核用户',
        phone: '13800009992',
        password: 'secret123',
        role_code: 'government_reviewer',
      },
    });

    const governmentLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: {
        phone: '13800009992',
        password: 'secret123',
      },
    });
    expect(governmentLogin.json().data.user.user_type).toBe('government');
    expect(governmentLogin.json().data.user.roles).toContain('reviewer');

    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        name: '平台管理用户',
        phone: '13800009993',
        password: 'secret123',
        role_code: 'platform_admin',
      },
    });

    const adminLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: {
        phone: '13800009993',
        password: 'secret123',
      },
    });
    expect(adminLogin.json().data.user.user_type).toBe('admin');
    expect(adminLogin.json().data.user.roles).toContain('system_admin');

    await app.close();
  });

  it('resets password and allows login with the new password only', async () => {
    const app = await buildApp();

    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        name: '重置密码用户',
        phone: '13800009994',
        password: 'oldSecret123',
      },
    });

    const reset = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/reset-password',
      payload: {
        phone: '13800009994',
        code: '123456',
        password: 'newSecret123',
      },
    });
    expect(reset.statusCode).toBe(200);
    expect(reset.json().data.password_reset).toBe(true);

    const oldLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: {
        phone: '13800009994',
        password: 'oldSecret123',
      },
    });
    expect(oldLogin.statusCode).toBe(401);

    const newLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: {
        phone: '13800009994',
        password: 'newSecret123',
      },
    });
    expect(newLogin.statusCode).toBe(200);
    expect(newLogin.json().data.user.phone).toBe('13800009994');

    await app.close();
  });
});
