import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { AliyunCloudMarketOcrProvider } from '../src/modules/ocr/providers/ocr-aliyun-cloud-market.provider.js';

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('failed to bind test server');
      }
      resolve(address.port);
    });
  });
}

describe('aliyun cloud market OCR provider', () => {
  const previousEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...previousEnv };
  });

  it('sends AppCode auth and normalizes cloud market OCR response', async () => {
    let receivedAuth = '';
    let receivedBody = '';
    const server = createServer((request, response) => {
      receivedAuth = request.headers.authorization ?? '';
      request.on('data', (chunk) => {
        receivedBody += chunk;
      });
      request.on('end', () => {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({
          data: {
            words_result: {
              enterprise_name: { words: 'Batch OCR Co', confidence: 96 },
              credit_code: { words: '913607XX0000000000', confidence: 95 },
            },
            confidence: 94,
          },
        }));
      });
    });
    const port = await listen(server);
    try {
      process.env.OCR_ALIYUN_MARKET_ENDPOINT = `http://127.0.0.1:${port}/ocr`;
      process.env.OCR_ALIYUN_MARKET_APPCODE = 'test-appcode';
      process.env.OCR_ALIYUN_MARKET_APPID = '112343563';
      process.env.OCR_ALIYUN_MARKET_APPNAME = '云市场1350670480';

      const result = await new AliyunCloudMarketOcrProvider().analyze({
        material_type: 'business_license',
        file_path: 'unused',
        file_base64: Buffer.from('fake-image').toString('base64'),
        mime_type: 'image/png',
        original_filename: 'license.png',
      });

      expect(receivedAuth).toBe('APPCODE test-appcode');
      expect(JSON.parse(receivedBody).img).toBe(Buffer.from('fake-image').toString('base64'));
      expect(result.material_type).toBe('business_license');
      expect(result.fields.enterprise_name).toBe('Batch OCR Co');
      expect(result.field_confidence.credit_code).toBe(0.95);
      expect(result.overall_confidence).toBe(0.94);
      expect(result.raw_provider_meta?.provider).toBe('aliyun_cloud_market');
      expect(result.raw_provider_meta?.app_id).toBe('112343563');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
