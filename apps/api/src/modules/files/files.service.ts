import { type MultipartFile } from '@fastify/multipart';
import { ApiError } from '../../common/errors/http-error.js';
import { loadEnv } from '../../config/env.js';
import { auditService } from '../audit/audit.service.js';
import { findApprovedEnterprisesByUserId } from '../enterprises/enterprises.repository.js';
import { insertFile } from './files.repository.js';
import { localFileStorageService } from './storage.service.js';

export type UploadedFileResponse = {
  file_id: string;
  enterprise_id: string | null;
  purpose: string;
  original_filename: string;
  mime_type: string;
  byte_size: number;
  file_hash: string;
  created_at: string;
};

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

export class FileService {
  async upload(input: {
    actor_id: string;
    trace_id: string;
    enterprise_id?: string;
    purpose?: string;
    file: MultipartFile;
  }): Promise<UploadedFileResponse> {
    const purpose = input.purpose ?? 'enterprise_resource';
    if (!['enterprise_resource', 'enterprise_binding'].includes(purpose)) {
      throw new ApiError('VALIDATION_ERROR', 'invalid file purpose');
    }
    if (purpose === 'enterprise_resource' && !input.enterprise_id) {
      throw new ApiError('VALIDATION_ERROR', 'enterprise_id is required');
    }

    if (purpose === 'enterprise_resource') {
      await assertEnterpriseMembership(input.actor_id, input.enterprise_id as string);
    }

    const env = loadEnv();
    let storageKey: string | undefined;

    try {
      const stored = await localFileStorageService.save({
        stream: input.file.file,
        original_filename: input.file.filename,
        max_bytes: env.fileUploadMaxBytes,
      });
      storageKey = stored.storage_key;

      const row = await insertFile({
        enterprise_id: purpose === 'enterprise_binding' ? null : input.enterprise_id,
        uploader_user_id: input.actor_id,
        original_filename: input.file.filename,
        mime_type: input.file.mimetype,
        byte_size: stored.byte_size,
        file_hash: stored.file_hash,
        storage_key: stored.storage_key,
        purpose,
      });

      await auditService.write({
        actor_id: input.actor_id,
        action: 'file.upload',
        target_type: 'file',
        target_id: row.file_id,
        trace_id: input.trace_id,
        detail: {
          enterprise_id: row.enterprise_id,
          purpose,
          original_filename: row.original_filename,
          mime_type: row.mime_type,
          byte_size: Number(row.byte_size),
          file_hash: row.file_hash,
        },
      });

      return {
        file_id: row.file_id,
        enterprise_id: row.enterprise_id,
        purpose: row.purpose,
        original_filename: row.original_filename,
        mime_type: row.mime_type,
        byte_size: Number(row.byte_size),
        file_hash: row.file_hash,
        created_at: row.created_at,
      };
    } catch (error) {
      if (storageKey) {
        await localFileStorageService.delete(storageKey).catch(() => undefined);
      }
      throw error;
    }
  }
}

export const fileService = new FileService();
