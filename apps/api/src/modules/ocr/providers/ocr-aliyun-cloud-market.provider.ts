import { ApiError } from '../../../common/errors/http-error.js';
import { loadEnv } from '../../../config/env.js';
import {
  type OcrAnalyzeResult,
  type OcrProviderAnalyzeInput,
  type SupportedOcrMaterialType,
} from './ocr.types.js';
import { type OcrProvider } from './ocr-provider.js';

type AliyunMarketPayload = Record<string, unknown>;

const DEFAULT_CONFIDENCE = 0.86;

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizeConfidence(value: unknown): number {
  const parsed = toNumber(value);
  if (parsed === null) {
    return DEFAULT_CONFIDENCE;
  }
  return parsed > 1 ? Math.min(parsed / 100, 1) : Math.max(parsed, 0);
}

function findNestedObject(
  payload: AliyunMarketPayload,
  keys: string[],
): Record<string, unknown> | null {
  for (const key of keys) {
    const value = payload[key];
    if (isObject(value)) {
      return value;
    }
    if (typeof value === 'string') {
      try {
        const parsed = JSON.parse(value) as unknown;
        if (isObject(parsed)) {
          return parsed;
        }
      } catch {
        // Keep looking; cloud-market OCR products vary in response envelopes.
      }
    }
  }
  return null;
}

function normalizeFieldKey(rawKey: string): string {
  const normalized = rawKey.trim().toLowerCase().replace(/\s+/g, '_');
  const mapping: Record<string, string> = {
    name: 'enterprise_name',
    enterprise_name: 'enterprise_name',
    company_name: 'enterprise_name',
    credit_code: 'credit_code',
    social_credit_code: 'credit_code',
    reg_num: 'credit_code',
    legal_person: 'legal_person',
    person: 'legal_person',
    address: 'registered_address',
    registered_address: 'registered_address',
    business_scope: 'business_scope',
    scope: 'business_scope',
  };
  return mapping[normalized] ?? normalized;
}

function extractFieldsFromWordsResult(
  wordsResult: unknown,
): { fields: Record<string, unknown>; confidence: Record<string, number> } {
  const fields: Record<string, unknown> = {};
  const confidence: Record<string, number> = {};

  if (isObject(wordsResult)) {
    for (const [rawKey, rawValue] of Object.entries(wordsResult)) {
      const key = normalizeFieldKey(rawKey);
      if (isObject(rawValue)) {
        const value =
          rawValue.words ?? rawValue.value ?? rawValue.text ?? rawValue.result;
        if (value !== undefined && value !== null && String(value).trim() !== '') {
          fields[key] = value;
          confidence[key] = normalizeConfidence(
            rawValue.confidence ?? rawValue.probability ?? rawValue.score,
          );
        }
      } else if (rawValue !== null && rawValue !== undefined && String(rawValue).trim() !== '') {
        fields[key] = rawValue;
        confidence[key] = DEFAULT_CONFIDENCE;
      }
    }
  }

  return { fields, confidence };
}

function extractTextLines(payload: AliyunMarketPayload): string[] {
  const candidates = [
    payload.words_result,
    payload.prism_wordsInfo,
    payload.lines,
    payload.words,
    payload.data,
  ];
  const lines: string[] = [];
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) {
      continue;
    }
    for (const item of candidate) {
      if (typeof item === 'string') {
        lines.push(item);
      } else if (isObject(item)) {
        const text = item.words ?? item.word ?? item.text ?? item.content;
        if (typeof text === 'string' && text.trim() !== '') {
          lines.push(text);
        }
      }
    }
  }
  return lines;
}

function normalizeAliyunResponse(
  materialType: SupportedOcrMaterialType,
  payload: AliyunMarketPayload,
): OcrAnalyzeResult {
  const nested =
    findNestedObject(payload, ['result', 'data', 'body']) ?? payload;
  const fieldsSource = isObject(nested.fields)
    ? nested.fields
    : nested.words_result ?? nested.wordsResult ?? nested;
  const confidenceSource = isObject(nested.field_confidence)
    ? nested.field_confidence
    : {};

  const extracted = extractFieldsFromWordsResult(fieldsSource);
  const fieldConfidence = {
    ...extracted.confidence,
  };

  for (const [key, value] of Object.entries(confidenceSource)) {
    fieldConfidence[normalizeFieldKey(key)] = normalizeConfidence(value);
  }

  const fields = extracted.fields;
  const overallConfidence =
    normalizeConfidence(
      nested.overall_confidence ??
        nested.confidence ??
        nested.score ??
        payload.confidence,
    );
  const textLines = extractTextLines(nested);
  const warnings: string[] = [];
  if (Object.keys(fields).length === 0 && textLines.length === 0) {
    warnings.push('aliyun OCR returned no structured fields or text lines');
  }

  return {
    material_type: materialType,
    fields,
    field_confidence: fieldConfidence,
    overall_confidence: overallConfidence,
    warnings,
    pages: [
      {
        page_no: 1,
        text: textLines.slice(0, 50).join('\n'),
        image_quality: 'unknown',
      },
    ],
    raw_provider_meta: {
      provider: 'aliyun_cloud_market',
      app_id: loadEnv().ocrAliyunMarketAppId,
      app_name: loadEnv().ocrAliyunMarketAppName,
    },
  };
}

export class AliyunCloudMarketOcrProvider implements OcrProvider {
  async analyze(input: OcrProviderAnalyzeInput): Promise<OcrAnalyzeResult> {
    const env = loadEnv();
    if (!env.ocrAliyunMarketEndpoint || !env.ocrAliyunMarketAppCode) {
      throw new ApiError(
        'INTERNAL_ERROR',
        'aliyun cloud market OCR endpoint or appcode is not configured',
      );
    }
    if (!input.file_base64 && !input.file_url) {
      throw new ApiError(
        'INTERNAL_ERROR',
        'aliyun cloud market OCR requires file_base64 or file_url',
      );
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), env.ocrServiceTimeoutMs);
    try {
      const requestBody = input.file_url
        ? { url: input.file_url, material_type: input.material_type }
        : {
            [env.ocrAliyunImageField]: input.file_base64,
            material_type: input.material_type,
            filename: input.original_filename,
          };

      const response = await fetch(env.ocrAliyunMarketEndpoint, {
        method: 'POST',
        headers: {
          authorization: `APPCODE ${env.ocrAliyunMarketAppCode}`,
          'content-type': 'application/json; charset=utf-8',
          connection: 'close',
          ...(env.ocrAliyunMarketAppKey ? { 'x-ca-key': env.ocrAliyunMarketAppKey } : {}),
          ...(env.ocrAliyunMarketAppSecret
            ? { 'x-ca-secret': env.ocrAliyunMarketAppSecret }
            : {}),
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });

      const payload = await response.json().catch(() => undefined) as unknown;
      if (!response.ok) {
        throw new ApiError(
          'INTERNAL_ERROR',
          `aliyun cloud market OCR failed with status ${response.status}`,
        );
      }
      if (!isObject(payload)) {
        throw new ApiError(
          'INTERNAL_ERROR',
          'aliyun cloud market OCR returned invalid response',
        );
      }
      return normalizeAliyunResponse(input.material_type, payload);
    } catch (error) {
      if (error instanceof ApiError) {
        throw error;
      }
      if (error instanceof Error && error.name === 'AbortError') {
        throw new ApiError('INTERNAL_ERROR', 'aliyun cloud market OCR timed out');
      }
      throw new ApiError(
        'INTERNAL_ERROR',
        error instanceof Error ? error.message : 'aliyun cloud market OCR failed',
      );
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

export const aliyunCloudMarketOcrProvider = new AliyunCloudMarketOcrProvider();
