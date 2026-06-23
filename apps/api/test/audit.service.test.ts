import { describe, expect, it } from 'vitest';
import {
  AuditService,
  NoopAuditRepository,
} from '../src/modules/audit/audit.service.js';

describe('audit service', () => {
  it('writes normalized audit log entries', async () => {
    const repository = new NoopAuditRepository();
    const service = new AuditService(repository);

    await service.write({
      actor_id: 'user_001',
      action: 'application.create',
      target_type: 'application',
      target_id: 'app_001',
      trace_id: 'trace_001',
    });

    expect(repository.logs).toEqual([
      {
        actor_id: 'user_001',
        action: 'application.create',
        target_type: 'application',
        target_id: 'app_001',
        trace_id: 'trace_001',
        detail: {},
      },
    ]);
  });
});
