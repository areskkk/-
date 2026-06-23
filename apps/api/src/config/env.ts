import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';

function loadEnvUpward(): void {
  let dir = process.cwd();
  do {
    const candidate = path.join(dir, '.env');
    if (fs.existsSync(candidate)) {
      dotenv.config({ path: candidate });
      return;
    }
    dir = path.dirname(dir);
  } while (dir !== path.dirname(dir));
  dotenv.config();
}

loadEnvUpward();

export type AppEnv = {
  nodeEnv: string;
  host: string;
  port: number;
  databaseUrl: string;
  jwtSecret: string;
  allowDevStubAuth: boolean;
  fileStorageRoot: string;
  fileUploadMaxBytes: number;
  ragServiceBaseUrl: string | null;
  ragServiceTimeoutMs: number;
  ragServiceInternalApiKey: string | null;
  ocrServiceBaseUrl: string | null;
  ocrServiceTimeoutMs: number;
  ocrServiceInternalApiKey: string | null;
  ocrProvider: string;
  ocrAliyunMarketEndpoint: string | null;
  ocrAliyunMarketAppCode: string | null;
  ocrAliyunMarketAppKey: string | null;
  ocrAliyunMarketAppSecret: string | null;
  ocrAliyunMarketAppId: string;
  ocrAliyunMarketAppName: string;
  ocrAliyunImageField: string;
  bailianBaseUrl: string;
  bailianApiKey: string | null;
  agentOrchestrationEnabled: boolean;
  agentModelSupervisor: string;
  agentModelRetrieval: string;
  agentModelPolicyAnalysis: string;
  agentModelMath: string;
  agentModelApplicationAssist: string;
  agentModelDocumentVision: string;
  agentModelReview: string;
  agentModelRiskJudge: string;
  agentLlmTimeoutMs: number;
  agentLlmMaxRetries: number;
  agentMaxGraphSteps: number;
  agentMaxToolCallsPerAgent: number;
  agentDefaultTemperature: number;
  agentConfidenceAnswer: number;
  agentConfidenceNeedJudge: number;
  agentConfidenceFallback: number;
  agentRunAsyncEnabled: boolean;
  agentRunWorkerAutostart: boolean;
  agentRunWorkerPollMs: number;
  agentRunWorkerId: string;
  agentRunStaleRunningMs: number;
  agentRateLimitPerUserPerDay: number;
  agentRateLimitPerEnterprisePerDay: number;
  agentMaxConcurrentRunsPerUser: number;
  agentMaxConcurrentRunsGlobal: number;
  agentMaxRunTokens: number;
  agentMaxRunCostCents: number;
  agentMaxDailyCostCents: number;
  agentModelCircuitBreakerEnabled: boolean;
  agentModelErrorRateThreshold: number;
  agentModelP95LatencyMs: number;
  agentModelCircuitBreakerOpenMs: number;
  agentModelCircuitBreakerWindowMs: number;
  agentFallbackModelEnabled: boolean;
  agentFallbackModelDefault: string | null;
  agentLlmEstimatedMaxTokens: number;
  agentLlmRedactionEnabled: boolean;
  agentFallbackSlaMinutes: number;
  ragBackendMode: string;
  ragRequirePersistentBackend: boolean;
};

function readNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }

  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid environment variable ${name}`);
  }

  return value;
}

function readNonNegativeInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }

  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Invalid environment variable ${name}`);
  }

  return value;
}

function readOptionalString(name: string): string | null {
  const raw = process.env[name];
  if (!raw) {
    return null;
  }

  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

function readBoolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }

  return raw.toLowerCase() === 'true';
}

function readFloat(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }

  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid environment variable ${name}`);
  }

  return value;
}

export function loadEnv(): AppEnv {
  return {
    nodeEnv: process.env.NODE_ENV ?? 'development',
    host: process.env.HOST ?? '0.0.0.0',
    port: readNumber('PORT', 3000),
    databaseUrl:
      process.env.DATABASE_URL ??
      'postgres://postgres:postgres@localhost:5432/nankang_zhuqibao',
    jwtSecret: process.env.JWT_SECRET ?? 'replace-with-a-long-random-string',
    allowDevStubAuth: readBoolean('ALLOW_DEV_STUB_AUTH', false),
    fileStorageRoot: process.env.FILE_STORAGE_ROOT ?? '.tmp/uploads',
    fileUploadMaxBytes: readNumber('FILE_UPLOAD_MAX_BYTES', 10 * 1024 * 1024),
    ragServiceBaseUrl: readOptionalString('RAG_SERVICE_BASE_URL'),
    ragServiceTimeoutMs: readNumber('RAG_SERVICE_TIMEOUT_MS', 2500),
    ragServiceInternalApiKey: readOptionalString('RAG_SERVICE_INTERNAL_API_KEY'),
    ocrServiceBaseUrl: readOptionalString('OCR_SERVICE_BASE_URL'),
    ocrServiceTimeoutMs: readNumber('OCR_SERVICE_TIMEOUT_MS', 15000),
    ocrServiceInternalApiKey: readOptionalString('OCR_SERVICE_INTERNAL_API_KEY'),
    ocrProvider: process.env.OCR_PROVIDER ?? 'sidecar',
    ocrAliyunMarketEndpoint: readOptionalString('OCR_ALIYUN_MARKET_ENDPOINT'),
    ocrAliyunMarketAppCode: readOptionalString('OCR_ALIYUN_MARKET_APPCODE'),
    ocrAliyunMarketAppKey: readOptionalString('OCR_ALIYUN_MARKET_APPKEY'),
    ocrAliyunMarketAppSecret: readOptionalString('OCR_ALIYUN_MARKET_APPSECRET'),
    ocrAliyunMarketAppId: process.env.OCR_ALIYUN_MARKET_APPID ?? '112343563',
    ocrAliyunMarketAppName:
      process.env.OCR_ALIYUN_MARKET_APPNAME ?? '云市场1350670480',
    ocrAliyunImageField: process.env.OCR_ALIYUN_IMAGE_FIELD ?? 'img',
    bailianBaseUrl:
      process.env.BAILIAN_BASE_URL ?? 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    bailianApiKey: readOptionalString('BAILIAN_API_KEY'),
    agentOrchestrationEnabled: readBoolean('AGENT_ORCHESTRATION_ENABLED', false),
    agentModelSupervisor: process.env.AGENT_MODEL_SUPERVISOR ?? 'qwen3.6-plus',
    agentModelRetrieval: process.env.AGENT_MODEL_RETRIEVAL ?? 'qwen3.6-plus',
    agentModelPolicyAnalysis:
      process.env.AGENT_MODEL_POLICY_ANALYSIS ?? 'qwen3.6-plus',
    agentModelMath: process.env.AGENT_MODEL_MATH ?? 'qwen3.6-plus',
    agentModelApplicationAssist:
      process.env.AGENT_MODEL_APPLICATION_ASSIST ?? 'qwen3.6-plus',
    agentModelDocumentVision:
      process.env.AGENT_MODEL_DOCUMENT_VISION ?? 'qwen3-vl-30b-a3b-thinking',
    agentModelReview: process.env.AGENT_MODEL_REVIEW ?? 'glm-5',
    agentModelRiskJudge:
      process.env.AGENT_MODEL_RISK_JUDGE ?? 'qwen3.6-plus',
    agentLlmTimeoutMs: readNumber('AGENT_LLM_TIMEOUT_MS', 60000),
    agentLlmMaxRetries: readNonNegativeInteger('AGENT_LLM_MAX_RETRIES', 2),
    agentMaxGraphSteps: readNumber('AGENT_MAX_GRAPH_STEPS', 20),
    agentMaxToolCallsPerAgent: readNumber('AGENT_MAX_TOOL_CALLS_PER_AGENT', 6),
    agentDefaultTemperature: readFloat('AGENT_DEFAULT_TEMPERATURE', 0.2),
    agentConfidenceAnswer: readFloat('AGENT_CONFIDENCE_ANSWER', 0.78),
    agentConfidenceNeedJudge: readFloat('AGENT_CONFIDENCE_NEED_JUDGE', 0.65),
    agentConfidenceFallback: readFloat('AGENT_CONFIDENCE_FALLBACK', 0.5),
    agentRunAsyncEnabled: readBoolean('AGENT_RUN_ASYNC_ENABLED', true),
    agentRunWorkerAutostart: readBoolean('AGENT_RUN_WORKER_AUTOSTART', true),
    agentRunWorkerPollMs: readNumber('AGENT_RUN_WORKER_POLL_MS', 1000),
    agentRunWorkerId: process.env.AGENT_RUN_WORKER_ID ?? `worker-${process.pid}`,
    agentRunStaleRunningMs: readNumber('AGENT_RUN_STALE_RUNNING_MS', 15 * 60 * 1000),
    agentRateLimitPerUserPerDay: readNumber('AGENT_RATE_LIMIT_PER_USER_PER_DAY', 50),
    agentRateLimitPerEnterprisePerDay: readNumber('AGENT_RATE_LIMIT_PER_ENTERPRISE_PER_DAY', 200),
    agentMaxConcurrentRunsPerUser: readNumber('AGENT_MAX_CONCURRENT_RUNS_PER_USER', 3),
    agentMaxConcurrentRunsGlobal: readNumber('AGENT_MAX_CONCURRENT_RUNS_GLOBAL', 50),
    agentMaxRunTokens: readNumber('AGENT_MAX_RUN_TOKENS', 120000),
    agentMaxRunCostCents: readNumber('AGENT_MAX_RUN_COST_CENTS', 200),
    agentMaxDailyCostCents: readNumber('AGENT_MAX_DAILY_COST_CENTS', 50000),
    agentModelCircuitBreakerEnabled: readBoolean('AGENT_MODEL_CIRCUIT_BREAKER_ENABLED', true),
    agentModelErrorRateThreshold: readFloat('AGENT_MODEL_ERROR_RATE_THRESHOLD', 0.2),
    agentModelP95LatencyMs: readNumber('AGENT_MODEL_P95_LATENCY_MS', 30000),
    agentModelCircuitBreakerOpenMs: readNumber('AGENT_MODEL_CIRCUIT_BREAKER_OPEN_MS', 60000),
    agentModelCircuitBreakerWindowMs: readNumber('AGENT_MODEL_CIRCUIT_BREAKER_WINDOW_MS', 300000),
    agentFallbackModelEnabled: readBoolean('AGENT_FALLBACK_MODEL_ENABLED', true),
    agentFallbackModelDefault: readOptionalString('AGENT_FALLBACK_MODEL_DEFAULT'),
    agentLlmEstimatedMaxTokens: readNumber('AGENT_LLM_ESTIMATED_MAX_TOKENS', 4096),
    agentLlmRedactionEnabled: readBoolean('AGENT_LLM_REDACTION_ENABLED', true),
    agentFallbackSlaMinutes: readNumber('AGENT_FALLBACK_SLA_MINUTES', 240),
    ragBackendMode: process.env.RAG_BACKEND_MODE ?? 'haystack_inmemory',
    ragRequirePersistentBackend: readBoolean(
      'RAG_REQUIRE_PERSISTENT_BACKEND',
      (process.env.NODE_ENV ?? 'development') === 'production',
    ),
  };
}
