// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  WorkspaceContentOperationKindType,
  WorkspaceContentResourceInput,
} from "@myoxus/graphql";

export type WorkspaceContentOperationSelection =
  | {
      type: "resources";
      resources: WorkspaceContentResourceInput[];
      label?: string;
    }
  | {
      type: "folder";
      folderId: string;
      label?: string;
    };

export type WorkspaceContentOperationDialogProps =
  | {
      kind: WorkspaceContentOperationKindType;
      selection: WorkspaceContentOperationSelection;
      resumeOperationId?: never;
    }
  | {
      kind?: never;
      selection?: never;
      resumeOperationId: string;
    };
