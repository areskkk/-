import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  OCR_TEST_INTERNAL_API_KEY,
  OcrSidecarTestManager,
} from './ocr-sidecar-test-utils.js';

const sidecar = new OcrSidecarTestManager({
  NODE_ENV: 'production',
  OCR_MAX_FILE_BYTES: '4',
  OCR_ALLOW_FIXTURE_PATH: 'false',
});

describe('ocr sidecar production boundary', () => {
  beforeAll(async () => {
    await sidecar.setupSuite();
  }, 180000);

  afterAll(async () => {
    await sidecar.teardownSuite();
  });

  it('rejects oversized base64 payloads', async () => {
    const response = await fetch(`${sidecar.baseUrl}/ocr/analyze`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-internal-api-key': OCR_TEST_INTERNAL_API_KEY,
      },
      body: JSON.stringify({
        material_type: 'business_license',
        file_base64: 'A'.repeat(12),
        mime_type: 'text/plain',
        original_filename: 'large.txt',
      }),
    });

    expect(response.status).toBe(413);
    expect((await response.json()).detail).toBe('file_base64 exceeds OCR_MAX_FILE_BYTES');
  });

  it('rejects file_path input in production', async () => {
    const response = await fetch(`${sidecar.baseUrl}/ocr/analyze`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-internal-api-key': OCR_TEST_INTERNAL_API_KEY,
      },
      body: JSON.stringify({
        material_type: 'business_license',
        file_path: 'test/fixtures/business-license-success.json',
        mime_type: 'application/json',
        original_filename: 'business-license-success.json',
      }),
    });

    expect(response.status).toBe(400);
  });
});
