import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform, type TransformCallback } from 'node:stream';
import { loadEnv } from '../../config/env.js';
import { ApiError } from '../../common/errors/http-error.js';

type StoredFile = {
  storage_key: string;
  byte_size: number;
  file_hash: string;
};

class HashAndLimitTransform extends Transform {
  private readonly hash = crypto.createHash('sha256');
  private byteSize = 0;

  constructor(private readonly maxBytes: number) {
    super();
  }

  _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    this.byteSize += chunk.length;
    if (this.byteSize > this.maxBytes) {
      callback(new ApiError('VALIDATION_ERROR', 'file size exceeds FILE_UPLOAD_MAX_BYTES'));
      return;
    }

    this.hash.update(chunk);
    callback(null, chunk);
  }

  result(): { byte_size: number; file_hash: string } {
    return {
      byte_size: this.byteSize,
      file_hash: this.hash.digest('hex'),
    };
  }
}

function normalizeStorageRoot(root: string): string {
  return path.resolve(root);
}

function createStorageKey(fileName: string): string {
  const extension = path.extname(fileName).toLowerCase();
  const safeExtension = extension.match(/^\.[a-z0-9]+$/) ? extension : '';
  return `${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}${safeExtension}`;
}

export class LocalFileStorageService {
  constructor(
    private readonly storageRoot?: string,
  ) {}

  private getStorageRoot(): string {
    return normalizeStorageRoot(this.storageRoot ?? loadEnv().fileStorageRoot);
  }

  async save(input: {
    stream: NodeJS.ReadableStream;
    original_filename: string;
    max_bytes: number;
  }): Promise<StoredFile> {
    const storageRoot = this.getStorageRoot();
    const storageKey = createStorageKey(input.original_filename);
    const targetPath = path.join(storageRoot, storageKey);
    const targetDir = path.dirname(targetPath);

    if (!targetPath.startsWith(storageRoot + path.sep)) {
      throw new ApiError('VALIDATION_ERROR', 'invalid storage key');
    }

    await fs.promises.mkdir(targetDir, { recursive: true });

    const hashAndLimit = new HashAndLimitTransform(input.max_bytes);
    try {
      await pipeline(input.stream, hashAndLimit, fs.createWriteStream(targetPath));
    } catch (error) {
      await fs.promises.rm(targetPath, { force: true }).catch(() => undefined);
      throw error;
    }
    const result = hashAndLimit.result();

    return {
      storage_key: storageKey,
      byte_size: result.byte_size,
      file_hash: result.file_hash,
    };
  }

  async delete(storageKey: string): Promise<void> {
    const storageRoot = this.getStorageRoot();
    const targetPath = path.join(storageRoot, storageKey);
    if (!targetPath.startsWith(storageRoot + path.sep)) {
      throw new ApiError('VALIDATION_ERROR', 'invalid storage key');
    }

    await fs.promises.rm(targetPath, { force: true });
  }

  resolveStoragePath(storageKey: string): string {
    const storageRoot = this.getStorageRoot();
    const targetPath = path.resolve(storageRoot, storageKey);
    if (!targetPath.startsWith(storageRoot + path.sep)) {
      throw new ApiError('VALIDATION_ERROR', 'invalid storage key');
    }

    return targetPath;
  }
}

export const localFileStorageService = new LocalFileStorageService();
