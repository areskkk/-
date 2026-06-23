import { ApiError } from '../../../common/errors/http-error.js';
import { loadEnv } from '../../../config/env.js';
import {
  type OcrAnalyzeResult,
  type OcrProviderAnalyzeInput,
} from './ocr.types.js';
import { type OcrProvider } from './ocr-provider.js';

type PaddleOcrSidecarResponse = OcrAnalyzeResult & {
  provider?: string;
};

function isValidAnalyzeResult(value: unknown): value is PaddleOcrSidecarResponse {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const response = value as PaddleOcrSidecarResponse;
  return (
    typeof response.material_type === 'string'
    && response.fields
    && typeof response.fields === 'object'
    && response.field_confidence
    && typeof response.field_confidence === 'object'
    && typeof response.overall_confidence === 'number'
    && Array.isArray(response.warnings)
  );
}

export class OcrSidecarProvider implements OcrProvider {
  async analyze(input: OcrProviderAnalyzeInput): Promise<OcrAnalyzeResult> {
    const env = loadEnv();
    if (!env.ocrServiceBaseUrl) {
      throw new ApiError(
        'INTERNAL_ERROR',
        'ocr service base url is not configured',
      );
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), env.ocrServiceTimeoutMs);

    try {
      const response = await fetch(
        new URL('/ocr/analyze', env.ocrServiceBaseUrl).toString(),
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(env.ocrServiceInternalApiKey
              ? { 'x-internal-api-key': env.ocrServiceInternalApiKey }
              : {}),
            connection: 'close',
          },
          body: JSON.stringify(input),
          signal: controller.signal,
        },
      );

      if (!response.ok) {
        throw new ApiError(
          'INTERNAL_ERROR',
          `ocr provider request failed with status ${response.status}`,
        );
      }

      const contentType = response.headers.get('content-type') ?? '';
      if (!contentType.toLowerCase().includes('application/json')) {
        throw new ApiError(
          'INTERNAL_ERROR',
          'ocr provider returned non-json response',
        );
      }

      const payload = await response.json();
      if (!isValidAnalyzeResult(payload)) {
        throw new ApiError(
          'INTERNAL_ERROR',
          'invalid ocr provider response',
        );
      }

      return payload;
    } catch (error) {
      if (error instanceof ApiError) {
        throw error;
      }

      if (error instanceof Error && error.name === 'AbortError') {
        throw new ApiError(
          'INTERNAL_ERROR',
          'ocr provider request timed out',
        );
      }

      throw new ApiError(
        'INTERNAL_ERROR',
        error instanceof Error ? error.message : 'ocr provider request failed',
      );
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

export const ocrSidecarProvider = new OcrSidecarProvider();
