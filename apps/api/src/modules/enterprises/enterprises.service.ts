import fs from 'node:fs/promises';
import { ApiError } from '../../common/errors/http-error.js';
import { withTransaction } from '../../db/query.js';
import { auditService } from '../audit/audit.service.js';
import { assignRole } from '../auth/auth.repository.js';
import { fallbackService } from '../fallback/fallback.service.js';
import { findFileById } from '../files/files.repository.js';
import { localFileStorageService } from '../files/storage.service.js';
import { getOcrProvider } from '../ocr/providers/ocr-provider.factory.js';
import {
  findEnterpriseByCreditCodeInTransaction,
  findEnterprisesByUserId,
  findLatestBusinessLicenseOcrByFileId,
  insertEnterpriseInTransaction,
  upsertEnterpriseAccountPreservingTerminalInTransaction,
} from './enterprises.repository.js';

export type BindEnterpriseRequest = {
  enterprise_name: string;
  credit_code: string;
  license_file_id: string;
};

type BindingOcrReview = {
  material_id: string | null;
  ocr_status: string;
  fields: Record<string, unknown>;
  field_confidence: Record<string, number>;
  overall_confidence: string | null;
  warnings: string[] | null;
  requires_manual_confirmation: boolean;
  source: 'material_ocr_result' | 'direct_binding_ocr';
};

function isValidCreditCode(value: string): boolean {
  return /^[0-9A-Z]{18}$/.test(value);
}

function normalizeText(value: unknown): string {
  return typeof value === 'string'
    ? value.trim().normalize('NFKC').replace(/\s+/g, '')
    : '';
}

function confidenceOf(fieldConfidence: Record<string, number>, key: string): number {
  const value = fieldConfidence[key];
  return typeof value === 'number' ? value : 0;
}

function createEnterpriseBindingFallbackSourceId(input: {
  user_id: string;
  credit_code: string;
  license_file_id: string;
}): string {
  return [
    'enterprise_binding',
    input.user_id,
    input.credit_code,
    input.license_file_id,
  ].join(':');
}

export class EnterpriseService {
  async bindEnterprise(
    actorId: string,
    traceId: string,
    input: BindEnterpriseRequest,
  ) {
    if (!input.enterprise_name || !input.credit_code || !input.license_file_id) {
      throw new ApiError(
        'VALIDATION_ERROR',
        'enterprise_name, credit_code and license_file_id are required',
      );
    }

    const enterpriseName = input.enterprise_name.trim();
    const creditCode = input.credit_code.trim().toUpperCase();
    const licenseFileId = input.license_file_id.trim();
    if (!isValidCreditCode(creditCode)) {
      throw new ApiError(
        'VALIDATION_ERROR',
        'credit_code must be 18 uppercase letters or digits',
      );
    }

    const licenseFile = await findFileById(licenseFileId);
    if (!licenseFile) {
      throw new ApiError('NOT_FOUND', 'license file not found');
    }
    if (licenseFile.uploader_user_id !== actorId) {
      throw new ApiError('FORBIDDEN', 'license file does not belong to current user');
    }
    if (licenseFile.purpose !== 'enterprise_binding') {
      throw new ApiError(
        'VALIDATION_ERROR',
        'license file purpose must be enterprise_binding',
      );
    }

    const riskItems: string[] = [];
    let ocr: BindingOcrReview | undefined;
    const existingOcr = await findLatestBusinessLicenseOcrByFileId(licenseFileId);
    if (existingOcr) {
      ocr = {
        ...existingOcr,
        source: 'material_ocr_result',
      };
    } else {
      try {
        const filePath = localFileStorageService.resolveStoragePath(licenseFile.storage_key);
        const fileBase64 = await fs.readFile(filePath, 'base64');
        const directOcr = await getOcrProvider().analyze({
          material_type: 'business_license',
          file_path: filePath,
          file_base64: fileBase64,
          mime_type: licenseFile.mime_type,
          original_filename: licenseFile.original_filename,
        });
        ocr = {
          material_id: null,
          ocr_status: directOcr.overall_confidence < 0.85
            ? 'low_confidence'
            : 'success',
          fields: directOcr.fields,
          field_confidence: directOcr.field_confidence,
          overall_confidence: String(directOcr.overall_confidence),
          warnings: directOcr.warnings,
          requires_manual_confirmation:
            directOcr.overall_confidence < 0.85 ||
            Object.values(directOcr.field_confidence).some((confidence) => confidence < 0.85),
          source: 'direct_binding_ocr',
        };
      } catch {
        riskItems.push('business_license_ocr_unavailable');
      }
    }
    if (!ocr) {
      riskItems.push('business_license_ocr_missing');
    }

    const ocrEnterpriseName = normalizeText(ocr?.fields.enterprise_name);
    const ocrCreditCode = normalizeText(ocr?.fields.credit_code).toUpperCase();
    const requestedEnterpriseName = normalizeText(enterpriseName);
    const nameMatched = Boolean(ocr) && ocrEnterpriseName === requestedEnterpriseName;
    const creditCodeMatched = Boolean(ocr) && ocrCreditCode === creditCode;
    const nameConfidence = ocr ? confidenceOf(ocr.field_confidence, 'enterprise_name') : 0;
    const creditCodeConfidence = ocr ? confidenceOf(ocr.field_confidence, 'credit_code') : 0;
    const overallConfidence = ocr?.overall_confidence ? Number(ocr.overall_confidence) : 0;
    const lowConfidence = ocr
      ? ocr.requires_manual_confirmation ||
        overallConfidence < 0.85 ||
        nameConfidence < 0.85 ||
        creditCodeConfidence < 0.85
      : false;
    if (ocr && !nameMatched) {
      riskItems.push('enterprise_name_mismatch');
    }
    if (ocr && !creditCodeMatched) {
      riskItems.push('credit_code_mismatch');
    }
    if (lowConfidence) {
      riskItems.push('business_license_ocr_low_confidence');
    }

    const txResult = await withTransaction(async (tx) => {
      let enterprise = await findEnterpriseByCreditCodeInTransaction(tx, creditCode);
      const existingEnterpriseMatched = Boolean(enterprise);
      const enterpriseNameMatch = enterprise
        ? enterprise.name.trim() === enterpriseName
        : false;
      if (existingEnterpriseMatched && !enterpriseNameMatch) {
        riskItems.push('existing_enterprise_name_mismatch');
      }

      const approved =
        !existingEnterpriseMatched &&
        Boolean(ocr) &&
        nameMatched &&
        creditCodeMatched &&
        !lowConfidence &&
        riskItems.length === 0;
      const requestedAuthStatus = approved ? 'agent_approved' : 'pending';

      if (!enterprise) {
        enterprise = await insertEnterpriseInTransaction(tx, {
          name: enterpriseName,
          credit_code: creditCode,
          status: 'pending',
        });
      }

      const account = await upsertEnterpriseAccountPreservingTerminalInTransaction(tx, {
        enterprise_id: enterprise.enterprise_id,
        user_id: actorId,
        role: 'owner',
        auth_status: requestedAuthStatus,
      });

      const updatedFile = await tx.queryOne<{ file_id: string }>(
        `
          UPDATE files
          SET enterprise_id = $2
          WHERE file_id = $1
            AND uploader_user_id = $3
            AND purpose = 'enterprise_binding'
          RETURNING file_id::text
        `,
        [licenseFileId, enterprise.enterprise_id, actorId],
      );
      if (!updatedFile) {
        throw new ApiError('CONFLICT', 'license file changed before enterprise binding');
      }

      return {
        enterprise,
        account,
        existingEnterpriseMatched,
        enterpriseNameMatch,
        approved,
        authStatus: account.auth_status,
      };
    });

    const decisionReason = txResult.approved
      ? '营业执照 OCR 与企业名称、统一社会信用代码一致，且关键字段置信度达标。'
      : '企业绑定需要人工审核：营业执照 OCR 缺失、低置信或与提交信息不一致。';

    if (txResult.authStatus === 'agent_approved') {
      await assignRole(actorId, 'owner');
    }

    let fallbackTask: { task_id: string; created: boolean } | null = null;
    if (txResult.authStatus === 'pending') {
      const fallback = await fallbackService.createIfNotExists({
        actor_id: actorId,
        trace_id: traceId,
        source_type: 'ocr',
        source_id: createEnterpriseBindingFallbackSourceId({
          user_id: actorId,
          credit_code: creditCode,
          license_file_id: licenseFileId,
        }),
        reason: 'enterprise_binding_requires_manual_review',
        context: {
          enterprise_id: txResult.enterprise.enterprise_id,
          enterprise_name: enterpriseName,
          credit_code: creditCode,
          license_file_id: licenseFileId,
          existing_enterprise_matched: txResult.existingEnterpriseMatched,
          enterprise_name_match: txResult.enterpriseNameMatch,
          risk_items: riskItems,
          ocr_result: ocr
            ? {
                material_id: ocr.material_id,
                source: ocr.source,
                ocr_status: ocr.ocr_status,
                enterprise_name: ocr.fields.enterprise_name ?? null,
                credit_code: ocr.fields.credit_code ?? null,
                field_confidence: ocr.field_confidence,
                overall_confidence: overallConfidence,
                warnings: ocr.warnings ?? [],
              }
            : null,
        },
      });
      fallbackTask = {
        task_id: fallback.task.task_id,
        created: fallback.created,
      };
    }

    await auditService.write({
      actor_id: actorId,
      action: 'enterprise.bind',
      target_type: 'enterprise',
      target_id: txResult.enterprise.enterprise_id,
      trace_id: traceId,
      detail: {
        credit_code: creditCode,
        license_file_id: licenseFileId,
        existing_enterprise_matched: txResult.existingEnterpriseMatched,
        enterprise_name_match: txResult.enterpriseNameMatch,
        ocr_checked: Boolean(ocr),
        ocr_name_match: nameMatched,
        ocr_credit_code_match: creditCodeMatched,
        ocr_low_confidence: lowConfidence,
        risk_items: riskItems,
        final_auth_status: txResult.authStatus,
        decision_reason: decisionReason,
        fallback_task_id: fallbackTask?.task_id ?? null,
      },
    });

    return {
      binding_id: txResult.account.account_id,
      status: txResult.authStatus,
      review: {
        type: 'agent_or_rule_review',
        result: txResult.authStatus === 'agent_approved'
          ? 'approved'
          : 'pending_manual_review',
        reason: decisionReason,
        risk_items: riskItems,
        existing_enterprise_matched: txResult.existingEnterpriseMatched,
        enterprise_name_match: txResult.enterpriseNameMatch,
        ocr: ocr
          ? {
              material_id: ocr.material_id,
              source: ocr.source,
              status: ocr.ocr_status,
              enterprise_name_match: nameMatched,
              credit_code_match: creditCodeMatched,
              overall_confidence: overallConfidence,
              requires_manual_confirmation: ocr.requires_manual_confirmation,
            }
          : null,
        fallback_task: fallbackTask,
      },
    };
  }

  async listMyEnterprises(actorId: string) {
    return findEnterprisesByUserId(actorId);
  }
}

export const enterpriseService = new EnterpriseService();
