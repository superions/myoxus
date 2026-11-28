// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import type {
  PreparedWorkspaceImport,
  SignedWorkspaceImportPart,
} from "./workspace-import";

export interface WorkspaceImportUploadRecovery {
  file: File;
  importId: string;
  prepared: PreparedWorkspaceImport;
  signedParts: SignedWorkspaceImportPart[];
}

export interface WorkspaceImportSessionState {
  importId: string;
  upload?: WorkspaceImportUploadRecovery;
}

/**
 * In-memory session store for an in-flight server workspace import.
 * Intentionally never persisted to browser storage so Browser Web preserves its
 * no-local-workspace boundary while allowing close/reopen recovery within the
 * current renderer session.
 */
class WorkspaceImportSessionStore {
  private current: WorkspaceImportSessionState | null = null;

  get(): WorkspaceImportSessionState | null {
    return this.current;
  }

  set(state: WorkspaceImportSessionState | null): void {
    this.current = state;
  }

  clearUpload(importId: string): void {
    this.current = { importId };
  }

  clear(): void {
    this.current = null;
  }
}

export const workspaceImportSessionStore = new WorkspaceImportSessionStore();
