import { loadEnv } from '../../../config/env.js';
import { aliyunCloudMarketOcrProvider } from './ocr-aliyun-cloud-market.provider.js';
import { ocrSidecarProvider } from './ocr-sidecar.provider.js';
import { type OcrProvider } from './ocr-provider.js';

let provider: OcrProvider | null = null;

export function getOcrProvider(): OcrProvider {
  if (provider === null) {
    const env = loadEnv();
    provider =
      env.ocrProvider === 'aliyun_cloud_market'
        ? aliyunCloudMarketOcrProvider
        : ocrSidecarProvider;
  }
  return provider;
}

export function setOcrProviderForTest(nextProvider: OcrProvider | null): void {
  provider = nextProvider;
}
