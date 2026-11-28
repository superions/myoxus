// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { useNavigateHelper } from "@myoxus/core/components/hooks/use-navigate-helper";
import type { FolderLinkType, FolderNode } from "@myoxus/core/modules/organize";
import { WorkspacesService } from "@myoxus/core/modules/workspace";
import { WorkspaceContentOperationService } from "@myoxus/core/modules/workspace-content-operation";
import type { MyoxusDNDData } from "@myoxus/core/types/dnd";
import { useI18n } from "@myoxus/i18n";
import {
  CloudWorkspaceIcon,
  CollectionsIcon,
  DatabaseIcon,
  PageIcon,
  TagIcon,
} from "@myoxus/icons/react";
import { useLiveData, useServices } from "@myoxus/infra";
import { notify } from "@myoxus/ui-facade";
import { useCallback, useMemo, useState } from "react";

import { StructureTreeNode } from "../../tree";
import type { GenericStructureTreeNode } from "../types";
import { isFolderLinkEntity } from "./dnd";
import {
  CROSS_WORKSPACE_RESOURCE_KINDS,
  isCrossWorkspaceResourceKind,
} from "./linked-folder";

const RESOURCE_KIND_LABELS: Record<
  keyof typeof CROSS_WORKSPACE_RESOURCE_KINDS,
  | "com.myoxus.workspace-content-operation.kind.collection"
  | "com.myoxus.workspace-content-operation.kind.database"
  | "com.myoxus.workspace-content-operation.kind.document"
  | "com.myoxus.workspace-content-operation.kind.tag"
> = {
  collection: "com.myoxus.workspace-content-operation.kind.collection",
  database: "com.myoxus.workspace-content-operation.kind.database",
  doc: "com.myoxus.workspace-content-operation.kind.document",
  tag: "com.myoxus.workspace-content-operation.kind.tag",
};

export interface StructureTreeCrossWorkspaceLinkNodeProps extends GenericStructureTreeNode {
  data: string;
  node: FolderNode;
  targetWorkspaceId: string;
  type: (string & {}) | FolderLinkType;
}

export function StructureTreeCrossWorkspaceLinkNode({
  canDrop,
  data,
  dropEffect,
  location,
  node,
  onDrop,
  operations,
  reorderable,
  targetWorkspaceId,
  type,
}: StructureTreeCrossWorkspaceLinkNodeProps) {
  const t = useI18n();
  const navigate = useNavigateHelper();
  const { workspaceContentOperationService, workspacesService } = useServices({
    WorkspaceContentOperationService,
    WorkspacesService,
  });
  const workspaces = useLiveData(workspacesService.list.workspaces$);
  const [denied, setDenied] = useState(false);

  const targetWorkspace = workspaces.find(
    (workspace) => workspace.id === targetWorkspaceId,
  );
  const kindLabel =
    type === "workspace"
      ? t["com.myoxus.settings.workspace"]()
      : isCrossWorkspaceResourceKind(type)
        ? t[RESOURCE_KIND_LABELS[type]]()
        : t["com.myoxus.workspace-content-operation.kind.unknown"]();
  const displayName =
    !denied && targetWorkspace?.name
      ? `${kindLabel} · ${targetWorkspace.name}`
      : kindLabel;

  const Icon = useCallback(
    ({ className }: { className?: string }) => {
      switch (type) {
        case "collection":
          return <CollectionsIcon className={className} />;
        case "database":
          return <DatabaseIcon className={className} />;
        case "tag":
          return <TagIcon className={className} />;
        case "workspace":
          return <CloudWorkspaceIcon className={className} />;
        default:
          return <PageIcon className={className} />;
      }
    },
    [type],
  );

  const dndData = useMemo<MyoxusDNDData | undefined>(() => {
    if (type === "workspace" || !isFolderLinkEntity(type) || !location) {
      return undefined;
    }
    return {
      draggable: {
        entity: { type, id: data },
        from: location,
      },
      dropTarget: { at: `structure-tree:${type}` },
    };
  }, [data, location, type]);

  const handleOpen = useCallback(async () => {
    try {
      if (type === "workspace") {
        const workspaceId =
          await workspaceContentOperationService.resolveWorkspaceHome(
            targetWorkspaceId,
          );
        if (workspaceId) {
          navigate.jumpToWorkspaceOverview(workspaceId);
          return;
        }
      } else if (isCrossWorkspaceResourceKind(type)) {
        const resource = await workspaceContentOperationService.resolveRedirect(
          {
            workspaceId: targetWorkspaceId,
            resource: {
              id: data,
              kind: CROSS_WORKSPACE_RESOURCE_KINDS[type],
            },
          },
        );
        if (resource) {
          navigate.jumpToWorkspaceResource(resource);
          return;
        }
      }
    } catch {
      // Permission, deletion and deployment mismatches converge on the same metadata-free UI result.
    }
    setDenied(true);
    notify.error({
      title: t["com.myoxus.workspace-content-operation.error.target-denied"](),
    });
  }, [
    data,
    navigate,
    t,
    targetWorkspaceId,
    type,
    workspaceContentOperationService,
  ]);

  return (
    <StructureTreeNode
      canDrop={canDrop}
      collapsed
      collapsible={false}
      data-testid={`structure-tree-cross-workspace-${node.id}`}
      dndData={dndData}
      dropEffect={dropEffect}
      icon={Icon}
      name={displayName}
      onClick={() => void handleOpen()}
      onDrop={onDrop}
      operations={operations}
      reorderable={reorderable}
      setCollapsed={() => undefined}
    />
  );
}
