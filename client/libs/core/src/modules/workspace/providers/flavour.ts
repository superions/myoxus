import type { AssistanceMode, CreateWorkspaceInput } from "@myoxus/graphql";
import { createIdentifier, type LiveData } from "@myoxus/infra";
import type {
  BlobStorage,
  DocStorage,
  ListedBlobRecord,
} from "@myoxus/storage";
import type { WorkerInitOptions } from "@myoxus/storage/worker/client";
import type { Workspace as BSWorkspace } from "@virgultum/editor/store";

import type { WorkspaceProfileInfo } from "../entities/profile";
import type { Workspace } from "../entities/workspace";
import type { WorkspaceMetadata } from "../metadata";

/** Interactive Empty creation bypasses legacy content initializers. */
export type EmptyWorkspaceCreation =
  | { kind: "cloud-empty"; input: CreateWorkspaceInput }
  | { kind: "local-empty"; name: string; assistanceMode: AssistanceMode };

export interface WorkspaceFlavourProvider {
  flavour: string;

  deleteWorkspace(id: string): Promise<void>;

  updateWorkspaceName(
    metadata: WorkspaceMetadata,
    name: string,
  ): Promise<string>;

  createWorkspace(
    initial: (
      docCollection: BSWorkspace,
      blobStorage: BlobStorage,
      docStorage: DocStorage,
    ) => Promise<void>,
    empty?: EmptyWorkspaceCreation,
  ): Promise<WorkspaceMetadata>;

  workspaces$: LiveData<WorkspaceMetadata[]>;

  /**
   * means the workspace list is loading. if it's true, the workspace page will show loading spinner.
   */
  isRevalidating$?: LiveData<boolean>;

  /**
   * revalidate the workspace list.
   *
   * will be called when user open workspace list, or workspace not found.
   */
  revalidate?: () => void;

  getWorkspaceProfile(
    metadata: WorkspaceMetadata,
    signal?: AbortSignal,
  ): Promise<WorkspaceProfileInfo | undefined>;

  getWorkspaceBlob(id: string, blob: string): Promise<Blob | null>;

  listBlobs(workspaceId: string): Promise<ListedBlobRecord[]>;

  deleteBlob(
    workspaceId: string,
    blob: string,
    permanent: boolean,
  ): Promise<void>;

  getEngineWorkerInitOptions(workspaceId: string): WorkerInitOptions;

  onWorkspaceInitialized?(workspace: Workspace): void;
}

export interface WorkspaceFlavoursProvider {
  workspaceFlavours$: LiveData<WorkspaceFlavourProvider[]>;
}

export const WorkspaceFlavoursProvider =
  createIdentifier<WorkspaceFlavoursProvider>("WorkspaceFlavoursProvider");
