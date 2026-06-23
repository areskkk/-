import { describe, expect, it } from 'vitest';
import { chunkPolicyContent } from '../src/modules/rag/chunking.js';

describe('rag chunking', () => {
  it('creates stable chunk order and required metadata', () => {
    const first = chunkPolicyContent({
      policy_id: '00000000-0000-0000-0000-000000000001',
      version: 'v1',
      title: '南康家具技改奖励政策',
      source_name: '南康区工信局',
      source_url: 'https://example.gov/policy',
      status: 'effective',
      content: [
        '# 申报条件',
        '南康家具制造企业完成数字化技改后，可以按设备投入申请奖励。',
        '# 材料要求',
        '企业需要提交营业执照、设备采购合同和付款凭证。',
      ].join('\n'),
    });
    const second = chunkPolicyContent({
      policy_id: '00000000-0000-0000-0000-000000000001',
      version: 'v1',
      title: '南康家具技改奖励政策',
      source_name: '南康区工信局',
      source_url: 'https://example.gov/policy',
      status: 'effective',
      content: [
        '# 申报条件',
        '南康家具制造企业完成数字化技改后，可以按设备投入申请奖励。',
        '# 材料要求',
        '企业需要提交营业执照、设备采购合同和付款凭证。',
      ].join('\n'),
    });

    expect(first.length).toBeGreaterThan(0);
    expect(first.map((chunk) => chunk.chunk_order)).toEqual([1, 2]);
    expect(first.map((chunk) => chunk.content_hash)).toEqual(
      second.map((chunk) => chunk.content_hash),
    );
    expect(first[0].metadata).toMatchObject({
      policy_id: '00000000-0000-0000-0000-000000000001',
      version: 'v1',
      title: '南康家具技改奖励政策',
      section_path: '申报条件',
      chunk_order: 1,
      source_name: '南康区工信局',
      source_url: 'https://example.gov/policy',
      status: 'effective',
    });
  });
});
