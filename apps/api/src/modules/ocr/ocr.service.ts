import fs from 'node:fs/promises';
import { ApiError } from '../../common/errors/http-error.js';
import { auditService } from '../audit/audit.service.js';
import { findApprovedEnterprisesByUserId } from '../enterprises/enterprises.repository.js';
import { localFileStorageService } from '../files/storage.service.js';
import {
  findLatestOcrResultByMaterialId,
  findMaterialForOcrById,
  insertOcrResult,
  type OcrResultRow,
  updateMaterialOcrStatus,
} from './ocr.repository.js';
import { enqueueOcrJob, type OcrJobRow } from './ocr-job.repository.js';
import {
  createOcrSourceId,
  fallbackService,
} from '../fallback/fallback.service.js';
import { getOcrProvider } from './providers/ocr-provider.factory.js';
import { type SupportedOcrMaterialType } from './providers/ocr.types.js';

export type StartOcrRequest = {
  mode?: 'provider' | 'async';
};

const OCR_LOW_CONFIDENCE_THRESHOLD = 0.85;
const SUPPORTED_MATERIAL_TYPES = new Set<string>([
  'business_license',
  'financial_report',
  'employment_proof',
  'contract',
  'other',
]);

function formatOcrResult(row: OcrResultRow) {
  return {
    ocr_result_id: row.ocr_result_id,
    material_id: row.material_id,
    material_type: row.material_type,
    fields: row.fields,
    field_confidence: row.field_confidence,
    overall_confidence: row.overall_confidence ? Number(row.overall_confidence) : null,
    warnings: row.warnings,
    requires_manual_confirmation: row.requires_manual_confirmation,
    created_at: row.created_at,
  };
}

async function assertEnterpriseMembership(
  actorId: string,
  enterpriseId: string,
): Promise<void> {
  const enterprises = await findApprovedEnterprisesByUserId(actorId);
  const matched = enterprises.find((enterprise) => enterprise.enterprise_id === enterpriseId);
  if (!matched) {
    throw new ApiError('FORBIDDEN', 'material access is denied');
  }
}

export class OcrService {
  async analyze(
    actorId: string,
    traceId: string,
    materialId: string,
    input: StartOcrRequest,
  ) {
    if (!materialId) {
      throw new ApiError('VALIDATION_ERROR', 'material_id is required');
    }

    const material = await findMaterialForOcrById(materialId);
    if (!material) {
      throw new ApiError('NOT_FOUND', 'material not found');
    }

    await assertEnterpriseMembership(actorId, material.enterprise_id);

    if (!material.is_current) {
      throw new ApiError('CONFLICT', 'only current material can be analyzed by OCR');
    }

    if (!SUPPORTED_MATERIAL_TYPES.has(material.material_type)) {
      throw new ApiError(
        'VALIDATION_ERROR',
        'unsupported OCR material_type',
      );
    }
    const materialType = material.material_type as SupportedOcrMaterialType;

    if (input?.mode === 'async') {
      const { job, created } = await enqueueOcrJob({
        material_id: material.material_id,
        actor_id: actorId,
        trace_id: traceId,
      });
      await updateMaterialOcrStatus({
        material_id: material.material_id,
        ocr_status: 'pending',
      });
      await auditService.write({
        actor_id: actorId,
        action: 'material.ocr.queued',
        target_type: 'material',
        target_id: material.material_id,
        trace_id: traceId,
        detail: {
          application_id: material.application_id,
          material_type: material.material_type,
          job_id: job.job_id,
          created,
        },
      });
      return {
        job_id: job.job_id,
        material_id: material.material_id,
        material_type: material.material_type,
        ocr_status: 'pending',
        async_status: job.status,
        created,
      };
    }

    return this.runAnalyzeForMaterial(actorId, traceId, material.material_id);
  }

  async runAnalyzeForMaterial(
    actorId: string,
    traceId: string,
    materialId: string,
    options: { markFailureOnError?: boolean } = {},
  ) {
    const markFailureOnError = options.markFailureOnError ?? true;
    const material = await findMaterialForOcrById(materialId);
    if (!material) {
      throw new ApiError('NOT_FOUND', 'material not found');
    }
    await assertEnterpriseMembership(actorId, material.enterprise_id);
    if (!material.is_current) {
      throw new ApiError('CONFLICT', 'only current material can be analyzed by OCR');
    }
    if (!SUPPORTED_MATERIAL_TYPES.has(material.material_type)) {
      throw new ApiError(
        'VALIDATION_ERROR',
        'unsupported OCR material_type',
      );
    }
    const materialType = material.material_type as SupportedOcrMaterialType;
    await updateMaterialOcrStatus({
      material_id: material.material_id,
      ocr_status: 'pending',
    });

    try {
      const provider = getOcrProvider();
      const filePath = localFileStorageService.resolveStoragePath(material.storage_key);
      const fileBase64 = await fs.readFile(filePath, 'base64');
      const analyzeResult = await provider.analyze({
        material_type: materialType,
        file_path: filePath,
        file_base64: fileBase64,
        mime_type: material.mime_type,
        original_filename: material.original_filename,
      });

      const hasLowConfidence =
        analyzeResult.overall_confidence < OCR_LOW_CONFIDENCE_THRESHOLD ||
        Object.values(analyzeResult.field_confidence).some(
          (confidence) => confidence < OCR_LOW_CONFIDENCE_THRESHOLD,
        );
      const providerSource =
        typeof analyzeResult.raw_provider_meta?.provider === 'string' &&
        analyzeResult.raw_provider_meta.provider.trim() !== ''
          ? analyzeResult.raw_provider_meta.provider.trim()
          : provider.constructor.name;

      const result = await insertOcrResult({
        material_id: material.material_id,
        material_type: materialType,
        fields: analyzeResult.fields,
        field_confidence: analyzeResult.field_confidence,
        overall_confidence: analyzeResult.overall_confidence,
        warnings: analyzeResult.warnings,
        requires_manual_confirmation: hasLowConfidence,
      });

      await auditService.write({
        actor_id: actorId,
        action: 'material.ocr.analyze',
        target_type: 'material',
        target_id: material.material_id,
        trace_id: traceId,
        detail: {
          application_id: material.application_id,
          material_type: material.material_type,
          provider: providerSource,
          ocr_status: hasLowConfidence ? 'low_confidence' : 'success',
          requires_manual_confirmation: hasLowConfidence,
          low_confidence_threshold: OCR_LOW_CONFIDENCE_THRESHOLD,
          overall_confidence: analyzeResult.overall_confidence,
          warnings: analyzeResult.warnings,
        },
      });

      let fallbackTask: { task_id: string; created: boolean } | null = null;
      if (hasLowConfidence) {
        const fallback = await fallbackService.createIfNotExists({
          actor_id: actorId,
          trace_id: traceId,
          source_type: 'ocr',
          source_id: createOcrSourceId(material.material_id),
          reason: 'ocr_requires_manual_confirmation',
          context: {
            material_id: material.material_id,
            application_id: material.application_id,
            material_type: material.material_type,
            ocr_result_id: result.ocr_result_id,
            overall_confidence: analyzeResult.overall_confidence,
            low_confidence_threshold: OCR_LOW_CONFIDENCE_THRESHOLD,
            warnings: analyzeResult.warnings,
          },
        });
        fallbackTask = {
          task_id: fallback.task.task_id,
          created: fallback.created,
        };
      }

      await updateMaterialOcrStatus({
        material_id: material.material_id,
        ocr_status: hasLowConfidence ? 'low_confidence' : 'success',
      });

      return {
        ...formatOcrResult(result),
        ocr_status: hasLowConfidence ? 'low_confidence' : 'success',
        fallback_task: fallbackTask,
      };
    } catch (error) {
      if (markFailureOnError) {
        await this.markAnalyzeFailed(
          actorId,
          traceId,
          material.material_id,
          error instanceof Error ? error.message : 'unknown ocr error',
        );
      }
      throw error;
    }
  }

  formatJob(job: OcrJobRow) {
    return {
      job_id: job.job_id,
      material_id: job.material_id,
      status: job.status,
      attempt_count: job.attempt_count,
      max_attempts: job.max_attempts,
      last_error: job.last_error,
      created_at: job.created_at,
      updated_at: job.updated_at,
    };
  }

  async markAnalyzeFailed(
    actorId: string,
    traceId: string,
    materialId: string,
    errorMessage: string,
  ): Promise<void> {
    const material = await findMaterialForOcrById(materialId);
    if (!material || material.ocr_status !== 'pending') {
      return;
    }
    await updateMaterialOcrStatus({
      material_id: materialId,
      ocr_status: 'failed',
    });

    await auditService.write({
      actor_id: actorId,
      action: 'material.ocr.analyze_failed',
      target_type: 'material',
      target_id: materialId,
      trace_id: traceId,
      detail: {
        application_id: material?.application_id ?? null,
        material_type: material?.material_type ?? null,
        ocr_status: 'failed',
        error_message: errorMessage,
      },
    });
  }

  async getLatest(actorId: string, materialId: string) {
    if (!materialId) {
      throw new ApiError('VALIDATION_ERROR', 'material_id is required');
    }

    const material = await findMaterialForOcrById(materialId);
    if (!material) {
      throw new ApiError('NOT_FOUND', 'material not found');
    }

    await assertEnterpriseMembership(actorId, material.enterprise_id);

    const result = await findLatestOcrResultByMaterialId(materialId);
    if (!result) {
      throw new ApiError('NOT_FOUND', 'ocr result not found');
    }

    return formatOcrResult(result);
  }
}

export const ocrService = new OcrService();
