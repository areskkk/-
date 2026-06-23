import { queryOne } from '../../db/query.js';

export type FileRow = {
  file_id: string;
  enterprise_id: string | null;
  uploader_user_id: string;
  original_filename: string;
  mime_type: string;
  byte_size: string;
  file_hash: string;
  storage_key: string;
  purpose: string;
  created_at: string;
};

export async function insertFile(input: {
  enterprise_id?: string | null;
  uploader_user_id: string;
  original_filename: string;
  mime_type: string;
  byte_size: number;
  file_hash: string;
  storage_key: string;
  purpose?: string;
}): Promise<FileRow> {
  const file = await queryOne<FileRow>(
    `
      INSERT INTO files (
        enterprise_id,
        uploader_user_id,
        original_filename,
        mime_type,
        byte_size,
        file_hash,
        storage_key,
        purpose
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING
        file_id::text,
        enterprise_id::text,
        uploader_user_id::text,
        original_filename,
        mime_type,
        byte_size::text,
        file_hash,
        storage_key,
        purpose,
        created_at::text
    `,
    [
      input.enterprise_id ?? null,
      input.uploader_user_id,
      input.original_filename,
      input.mime_type,
      input.byte_size,
      input.file_hash,
      input.storage_key,
      input.purpose ?? 'enterprise_resource',
    ],
  );

  if (!file) {
    throw new Error('Failed to create file metadata');
  }

  return file;
}

export async function findFileById(fileId: string): Promise<FileRow | undefined> {
  return queryOne<FileRow>(
    `
      SELECT
        file_id,
        enterprise_id::text,
        uploader_user_id::text,
        original_filename,
        mime_type,
        byte_size::text,
        file_hash,
        storage_key,
        purpose,
        created_at::text
      FROM files
      WHERE file_id = $1
    `,
    [fileId],
  );
}
