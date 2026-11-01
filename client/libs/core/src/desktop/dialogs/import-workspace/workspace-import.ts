// SPDX-License-Identifier: AGPL-3.0-or-later

import { createSHA256 } from "hash-wasm";

/** Fixed by the server upload contract; a mismatch aborts before any PUT. */
export const WORKSPACE_IMPORT_PART_BYTES = 8 * 1024 * 1024;

export type WorkspaceImportManifestPart = {
  partNumber: number;
  sizeBytes: number;
  contentHash: string;
};

export type PreparedWorkspaceImport = {
  sourceHash: string;
  sourceSizeBytes: number;
  parts: WorkspaceImportManifestPart[];
};

export type SignedWorkspaceImportPart = WorkspaceImportManifestPart & {
  uploadUrl: string;
};

function abortIfNeeded(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new DOMException("Workspace import aborted", "AbortError");
  }
}

/**
 * Builds whole-file and per-part SHA-256 hashes incrementally. At most one
 * upload part is materialized at a time, including for the configured maximum.
 */
export async function prepareWorkspaceImport(
  file: File,
  options: {
    partSizeBytes?: number;
    signal?: AbortSignal;
    onProgress?: (processedBytes: number, totalBytes: number) => void;
  } = {},
): Promise<PreparedWorkspaceImport> {
  const partSizeBytes = options.partSizeBytes ?? WORKSPACE_IMPORT_PART_BYTES;
  if (!Number.isSafeInteger(partSizeBytes) || partSizeBytes < 1) {
    throw new Error("Workspace import part size must be a positive integer");
  }
  if (file.size < 1) {
    throw new Error("Workspace import file is empty");
  }

  const sourceHasher = await createSHA256();
  const parts: WorkspaceImportManifestPart[] = [];
  for (let offset = 0, partNumber = 1; offset < file.size; partNumber += 1) {
    abortIfNeeded(options.signal);
    const end = Math.min(offset + partSizeBytes, file.size);
    const bytes = new Uint8Array(await file.slice(offset, end).arrayBuffer());
    const partHasher = await createSHA256();
    partHasher.update(bytes);
    sourceHasher.update(bytes);
    parts.push({
      partNumber,
      sizeBytes: bytes.byteLength,
      contentHash: partHasher.digest("hex"),
    });
    offset = end;
    options.onProgress?.(offset, file.size);
  }

  return {
    sourceHash: sourceHasher.digest("hex"),
    sourceSizeBytes: file.size,
    parts,
  };
}

/** Uploads signed parts serially so browser memory and network pressure stay bounded. */
export async function uploadWorkspaceImportParts(
  file: File,
  parts: readonly SignedWorkspaceImportPart[],
  options: {
    signal?: AbortSignal;
    fetcher?: typeof fetch;
    onProgress?: (uploadedBytes: number, totalBytes: number) => void;
  } = {},
): Promise<void> {
  const fetcher = options.fetcher ?? fetch;
  const totalBytes = parts.reduce((total, part) => total + part.sizeBytes, 0);
  let uploadedBytes = 0;
  let offset = 0;

  for (const part of parts) {
    abortIfNeeded(options.signal);
    const body = await file
      .slice(offset, offset + part.sizeBytes)
      .arrayBuffer();
    const response = await fetcher(part.uploadUrl, {
      method: "PUT",
      body,
      signal: options.signal,
    });
    if (!response.ok) {
      throw new Error(`Workspace import upload failed (${response.status})`);
    }
    offset += part.sizeBytes;
    uploadedBytes += part.sizeBytes;
    options.onProgress?.(uploadedBytes, totalBytes);
  }

  if (offset !== file.size) {
    throw new Error("Workspace import upload manifest does not match the file");
  }
}

export function workspaceImportProgress(
  current: number,
  total: number,
): number {
  if (!Number.isFinite(current) || !Number.isFinite(total) || total <= 0) {
    return 0;
  }
  return Math.round(Math.max(0, Math.min(1, current / total)) * 100);
}

export function isWorkspaceImportPollingStatus(status?: string | null) {
  return status === "queued" || status === "running";
}

/** Display only the actor-scoped source path, never arbitrary diagnostic JSON. */
export function workspaceImportDiagnosticSourcePath(context: unknown) {
  if (!context || typeof context !== "object" || Array.isArray(context))
    return undefined;
  const path = (context as Record<string, unknown>).sourcePath;
  return typeof path === "string" && path.trim() ? path : undefined;
}
