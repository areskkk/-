import { ApiError } from '../../common/errors/http-error.js';
import { auditService } from '../audit/audit.service.js';
import { findApplicationDetailById } from '../applications/applications.repository.js';
import { findApprovedEnterprisesByUserId } from '../enterprises/enterprises.repository.js';
import { findFileById } from '../files/files.repository.js';
import { insertMaterial } from './materials.repository.js';

export type CreateMaterialRequest = {
  application_id: string;
  material_type: string;
  file_id: string;
  issue_date?: string;
  expire_date?: string;
  security_level?: string;
};

const ALLOWED_SECURITY_LEVELS = new Set(['L1', 'L2', 'L3', 'L4']);

async function assertEnterpriseMembership(
  actorId: string,
  enterpriseId: string,
): Promise<void> {
  const enterprises = await findApprovedEnterprisesByUserId(actorId);
  const matched = enterprises.find((enterprise) => enterprise.enterprise_id === enterpriseId);
  if (!matched) {
    throw new ApiError('FORBIDDEN', 'enterprise access is denied');
  }
}

export class MaterialService {
  async create(actorId: string, traceId: string, input: CreateMaterialRequest) {
    if (!input.application_id || !input.material_type || !input.file_id) {
      throw new ApiError(
        'VALIDATION_ERROR',
        'application_id, material_type and file_id are required',
      );
    }

    if (
      input.security_level &&
      !ALLOWED_SECURITY_LEVELS.has(input.security_level)
    ) {
      throw new ApiError('VALIDATION_ERROR', 'invalid security_level');
    }

    const applicationRows = await findApplicationDetailById(input.application_id);
    if (applicationRows.length === 0) {
      throw new ApiError('NOT_FOUND', 'application not found');
    }

    const application = applicationRows[0];
    await assertEnterpriseMembership(actorId, application.enterprise_id);

    if (application.status !== 'draft') {
      throw new ApiError(
        'CONFLICT',
        'materials can only be bound to draft applications in Batch 4',
      );
    }

    const file = await findFileById(input.file_id);
    if (!file) {
      throw new ApiError('NOT_FOUND', 'file not found');
    }

    if (file.enterprise_id !== application.enterprise_id) {
      throw new ApiError('FORBIDDEN', 'file does not belong to application enterprise');
    }

    const material = await insertMaterial({
      application_id: input.application_id,
      policy_item_id: applicationRows.length === 1
        ? applicationRows[0].policy_item_id
        : null,
      material_type: input.material_type,
      file_id: input.file_id,
      file_hash: file.file_hash,
      issue_date: input.issue_date,
      expire_date: input.expire_date,
      security_level: input.security_level,
    });

    await auditService.write({
      actor_id: actorId,
      action: 'material.create',
      target_type: 'material',
      target_id: material.material_id,
      trace_id: traceId,
      detail: {
        application_id: input.application_id,
        enterprise_id: application.enterprise_id,
        file_id: input.file_id,
        material_type: input.material_type,
        batch4_rule: 'draft_application_only',
      },
    });

    return {
      ...material,
      original_filename: file.original_filename,
      mime_type: file.mime_type,
      byte_size: Number(file.byte_size),
    };
  }
}

export const materialService = new MaterialService();
