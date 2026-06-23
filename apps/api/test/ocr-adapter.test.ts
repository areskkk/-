import path from 'node:path';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { ocrSidecarProvider } from '../src/modules/ocr/providers/ocr-sidecar.provider.js';
import {
  fetchOcrReady,
  OCR_TEST_INTERNAL_API_KEY,
  OcrSidecarTestManager,
} from './ocr-sidecar-test-utils.js';

const sidecar = new OcrSidecarTestManager();

describe('ocr sidecar provider', () => {
  beforeAll(async () => {
    process.env.OCR_SERVICE_BASE_URL = sidecar.baseUrl;
    process.env.OCR_SERVICE_TIMEOUT_MS = '15000';
    process.env.OCR_SERVICE_INTERNAL_API_KEY = OCR_TEST_INTERNAL_API_KEY;
    await sidecar.setupSuite();
  }, 180000);

  afterAll(async () => {
    await sidecar.teardownSuite();
  }, 20000);

  it('reads a business license fixture and returns normalized OCR output', async () => {
    const result = await ocrSidecarProvider.analyze({
      material_type: 'business_license',
      file_path: path.resolve('test/fixtures/business-license-success.json'),
      mime_type: 'application/json',
      original_filename: 'business-license-success.json',
    });

    expect(result.material_type).toBe('business_license');
    expect(result.fields.enterprise_name).toBe('南康某家具有限公司');
    expect(result.field_confidence.credit_code).toBe(0.95);
    expect(result.overall_confidence).toBe(0.94);
    expect(result.warnings).toEqual([]);
  });

  it('exposes sidecar ready checks for production deployment gates', async () => {
    const ready = await fetchOcrReady(sidecar.baseUrl);

    expect(ready.status).toBe('ok');
    expect(ready.checks.provider_engine).toBe('rapidocr');
    expect(ready.checks.internal_api_key).toBe('ok');
    expect(ready.checks.file_base64_supported).toBe(true);
    expect(ready.checks.supported_material_types).toEqual([
      'business_license',
      'contract',
      'employment_proof',
      'financial_report',
      'other',
    ]);
  });

  it('rejects OCR analyze requests without internal api key when configured', async () => {
    const response = await fetch(`${sidecar.baseUrl}/ocr/analyze`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        material_type: 'business_license',
        file_path: path.resolve('test/fixtures/business-license-success.json'),
        mime_type: 'application/json',
        original_filename: 'business-license-success.json',
      }),
    });

    expect(response.status).toBe(401);
  });
});
