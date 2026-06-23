import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  canConnectDatabase,
  createApprovedEnterpriseForUser,
  getRows,
  prepareDatabase,
  truncateBusinessTables,
} from './db-test-utils.js';
import { createRun } from '../src/modules/agents/agents.repository.js';
import { agentToolRunner } from '../src/modules/agents/tools/tool-runner.js';
import { AgentToolError } from '../src/modules/agents/tools/tool.types.js';
import { type MaterialEvidenceReadToolOutput } from '../src/modules/agents/tools/material-read.tool.js';

const canRunDb = await canConnectDatabase();
const describeIfDb = canRunDb ? describe : describe.skip;
const actorId = '00000000-0000-0000-0000-000000000901';
const otherActorId = '00000000-0000-0000-0000-000000000902';
const reviewerId = '00000000-0000-0000-0000-000000000903';

describeIfDb('agent tool runner integration', () => {
  beforeAll(async () => {
    await prepareDatabase();
  });

  beforeEach(async () => {
    process.env.AGENT_MAX_TOOL_CALLS_PER_AGENT = '1';
    await truncateBusinessTables();
    await getRows(
      `
        INSERT INTO users (user_id, name, phone, user_type)
        VALUES
          ($1, 'Tool Actor', '13900000901', 'enterprise'),
          ($2, 'Other Tool Actor', '13900000902', 'enterprise'),
          ($3, 'Review Tool Actor', '13900000903', 'government')
      `,
      [actorId, otherActorId, reviewerId],
    );
    await getRows(
      `
        INSERT INTO user_roles (user_id, role_id)
        SELECT $1, role_id
        FROM roles
        WHERE code = 'reviewer'
      `,
      [reviewerId],
    );
  });

  it('records failed tool calls for allowed agent rejection and tool call limit', async () => {
    const run = await createTestRun('tool-limit-trace');

    await expect(agentToolRunner.execute('rag.search', {
      query: '稳岗补贴',
    }, {
      run_id: run.run_id,
      actor_id: actorId,
      trace_id: 'tool-limit-trace',
      agent_type: 'review',
    })).rejects.toMatchObject({
      type: 'tool_not_allowed',
    });

    await getRows(
      `
        INSERT INTO agent_tool_calls (run_id, tool_name, input, output, status, completed_at)
        VALUES (
          $1,
          'rag.search',
          '{"agent_type":"retrieval_planner","actor_id":"00000000-0000-0000-0000-000000000901","trace_id":"tool-limit-trace"}'::jsonb,
          '{}'::jsonb,
          'completed',
          now()
        )
      `,
      [run.run_id],
    );
    await expect(agentToolRunner.execute('rag.search', {
      query: '稳岗补贴',
    }, {
      run_id: run.run_id,
      actor_id: actorId,
      trace_id: 'tool-limit-trace',
      agent_type: 'retrieval_planner',
    })).rejects.toMatchObject({
      type: 'tool_limit_exceeded',
    });

    const rows = await getRows<{
      tool_name: string;
      status: string;
      input: Record<string, unknown>;
      output: Record<string, unknown>;
    }>(
      `
        SELECT tool_name, status, input, output
        FROM agent_tool_calls
        WHERE run_id = $1
        ORDER BY started_at ASC, tool_call_id ASC
      `,
      [run.run_id],
    );
    expect(rows.map((row) => row.status)).toEqual(['failed', 'completed', 'failed']);
    expect(rows[0].output.error_type).toBe('tool_not_allowed');
    expect(rows[0].input.actor_id).toBe(actorId);
    expect(rows[0].input.trace_id).toBe('tool-limit-trace');
    expect(rows[2].output.error_type).toBe('tool_limit_exceeded');
    expect(rows[2].output.retryable).toBe(false);
  });

  it('classifies forbidden material reads as permission denied and records failed tool call', async () => {
    const enterpriseId = await createApprovedEnterpriseForUser({
      userId: actorId,
      enterpriseName: 'Tool Enterprise',
      creditCode: '91360700000000901X',
    });
    const fixture = await createApplicationFixture({
      enterpriseId,
      applicantUserId: actorId,
    });
    const run = await createTestRun('material-permission-trace');

    await expect(agentToolRunner.execute('ocr.material_evidence.read', {
      application_id: fixture.applicationId,
      mode: 'summary',
    }, {
      run_id: run.run_id,
      actor_id: otherActorId,
      trace_id: 'material-permission-trace',
      agent_type: 'document_vision',
      entrypoint: 'application',
    })).rejects.toMatchObject({
      type: 'permission_denied',
      retryable: false,
    });

    const rows = await getRows<{ output: Record<string, unknown>; status: string }>(
      `
        SELECT status, output
        FROM agent_tool_calls
        WHERE run_id = $1
        ORDER BY started_at DESC
        LIMIT 1
      `,
      [run.run_id],
    );
    expect(rows[0].status).toBe('failed');
    expect(rows[0].output).toMatchObject({
      error_type: 'permission_denied',
      retryable: false,
    });
  });

  it('lets government reviewers read summary material evidence without OCR fields in review scope', async () => {
    const enterpriseId = await createApprovedEnterpriseForUser({
      userId: actorId,
      enterpriseName: 'Summary Enterprise',
      creditCode: '91360700000000903X',
    });
    const fixture = await createApplicationFixture({
      enterpriseId,
      applicantUserId: actorId,
      ocrFields: { revenue: 1000, secret: 'do-not-store-in-review-state' },
    });
    const run = await createTestRun('material-summary-trace');

    const result = await agentToolRunner.execute<MaterialEvidenceReadToolOutput>(
      'ocr.material_evidence.read',
      {
        application_id: fixture.applicationId,
        mode: 'summary',
      },
      {
        run_id: run.run_id,
        actor_id: reviewerId,
        trace_id: 'material-summary-trace',
        agent_type: 'document_vision',
        entrypoint: 'review',
        item_id: fixture.itemId,
      },
    );

    expect(result.output.materials[0].fields).toEqual({});
    expect(JSON.stringify(result.output.materials)).not.toContain('do-not-store-in-review-state');
  });

  it('does not allow generic document vision reads to bypass review scope binding', async () => {
    const enterpriseId = await createApprovedEnterpriseForUser({
      userId: actorId,
      enterpriseName: 'Bound Review Enterprise',
      creditCode: '91360700000000904X',
    });
    const fixture = await createApplicationFixture({
      enterpriseId,
      applicantUserId: actorId,
    });
    const run = await createTestRun('generic-review-bypass-trace');

    await expect(agentToolRunner.execute('ocr.material_evidence.read', {
      application_id: fixture.applicationId,
      mode: 'summary',
    }, {
      run_id: run.run_id,
      actor_id: reviewerId,
      trace_id: 'generic-review-bypass-trace',
      agent_type: 'document_vision',
      entrypoint: 'mock_completed',
    })).rejects.toMatchObject({
      type: 'permission_denied',
    });

    const missingItemRun = await createTestRun('review-missing-item-trace');
    await expect(agentToolRunner.execute('ocr.material_evidence.read', {
      application_id: fixture.applicationId,
      mode: 'summary',
    }, {
      run_id: missingItemRun.run_id,
      actor_id: reviewerId,
      trace_id: 'review-missing-item-trace',
      agent_type: 'document_vision',
      entrypoint: 'review',
    })).rejects.toMatchObject({
      type: 'invalid_input',
    });
  });
});

async function createTestRun(traceId: string) {
  return createRun({
    actor_id: actorId,
    entrypoint: 'mock_completed',
    trace_id: traceId,
    state: {
      run_id: 'pending',
      trace_id: traceId,
      actor_id: actorId,
      entrypoint: 'mock_completed',
      input: {},
      errors: [],
    },
    status: 'running',
  });
}

async function createApplicationFixture(input: {
  enterpriseId: string;
  applicantUserId: string;
  ocrFields?: Record<string, unknown>;
}): Promise<{ applicationId: string; itemId: string }> {
  const policy = await getRows<{ policy_id: string }>(
    `
      INSERT INTO policies (title, source_type, status, version, content)
      VALUES ('Tool Policy', 'manual', 'effective', 'v1', 'content')
      RETURNING policy_id::text
    `,
  );
  const snapshot = await getRows<{ snapshot_id: string }>(
    `
      INSERT INTO enterprise_profile_snapshots (
        enterprise_id,
        industry,
        source,
        profile_json
      )
      VALUES ($1, 'manufacturing', 'test', '{}'::jsonb)
      RETURNING snapshot_id::text
    `,
    [input.enterpriseId],
  );
  const application = await getRows<{ application_id: string }>(
    `
      INSERT INTO applications (
        enterprise_id,
        applicant_user_id,
        profile_snapshot_id,
        status
      )
      VALUES ($1, $2, $3, 'submitted')
      RETURNING application_id::text
    `,
    [input.enterpriseId, input.applicantUserId, snapshot[0].snapshot_id],
  );
  const item = await getRows<{ item_id: string }>(
    `
      INSERT INTO application_policy_items (application_id, policy_id, status)
      VALUES ($1, $2, 'submitted')
      RETURNING item_id::text
    `,
    [application[0].application_id, policy[0].policy_id],
  );
  const file = await getRows<{ file_id: string }>(
    `
      INSERT INTO files (
        enterprise_id,
        uploader_user_id,
        original_filename,
        mime_type,
        byte_size,
        file_hash,
        storage_key
      )
      VALUES ($1, $2, 'license.pdf', 'application/pdf', 10, 'hash-tool', gen_random_uuid()::text)
      RETURNING file_id::text
    `,
    [input.enterpriseId, input.applicantUserId],
  );
  const material = await getRows<{ material_id: string }>(
    `
      INSERT INTO materials (
        application_id,
        policy_item_id,
        material_type,
        file_id,
        file_hash,
        ocr_status,
        is_current
      )
      VALUES ($1, $2, 'business_license', $3, 'hash-tool', 'success', true)
      RETURNING material_id::text
    `,
    [application[0].application_id, item[0].item_id, file[0].file_id],
  );
  await getRows(
    `
      INSERT INTO ocr_results (
        material_id,
        fields,
        field_confidence,
        overall_confidence,
        warnings,
        requires_manual_confirmation
      )
      VALUES ($1, $2::jsonb, '{"revenue":0.99}'::jsonb, 0.99, '[]'::jsonb, false)
    `,
    [material[0].material_id, JSON.stringify(input.ocrFields ?? { revenue: 1000 })],
  );
  return {
    applicationId: application[0].application_id,
    itemId: item[0].item_id,
  };
}
