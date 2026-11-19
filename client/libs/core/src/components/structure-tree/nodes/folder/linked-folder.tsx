// SPDX-License-Identifier: AGPL-3.0-or-later
import { useNavigateHelper } from "@myoxus/core/components/hooks/use-navigate-helper";
import { WorkspaceContentOperationService } from "@myoxus/core/modules/workspace-content-operation";
import {
  WorkspaceContentResourceKindType,
  type WorkspaceLinkedFolderQuery,
} from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import {
  CloudWorkspaceIcon,
  CollectionsIcon,
  DatabaseIcon,
  FolderIcon,
  FolderOpenIcon,
  LinkIcon,
  PageIcon,
  TagIcon,
} from "@myoxus/icons/react";
import { useService } from "@myoxus/infra";
import { notify } from "@myoxus/ui-facade";
import { type ComponentType, useEffect, useState } from "react";

import type { BaseStructureTreeNodeProps } from "../../tree/node";
import type { NodeOperation } from "../../tree/types";

export const CROSS_WORKSPACE_RESOURCE_KINDS = {
  collection: WorkspaceContentResourceKindType.Collection,
  database: WorkspaceContentResourceKindType.Database,
  doc: WorkspaceContentResourceKindType.Document,
  tag: WorkspaceContentResourceKindType.Tag,
} as const;

export function isCrossWorkspaceResourceKind(
  type: string,
): type is keyof typeof CROSS_WORKSPACE_RESOURCE_KINDS {
  return Object.hasOwn(CROSS_WORKSPACE_RESOURCE_KINDS, type);
}

type Folder = NonNullable<WorkspaceLinkedFolderQuery["workspaceLinkedFolder"]>;
const icons = {
  collection: CollectionsIcon,
  database: DatabaseIcon,
  doc: PageIcon,
  tag: TagIcon,
};
const rootPath: readonly string[] = [];

export function LinkedFolderNode({
  treeNode: TreeNode,
  workspaceId,
  folderId,
  name,
  ancestors = rootPath,
  operations,
  linked = true,
}: {
  treeNode: ComponentType<BaseStructureTreeNodeProps>;
  workspaceId: string;
  folderId: string;
  name?: string;
  ancestors?: readonly string[];
  operations?: NodeOperation[];
  linked?: boolean;
}) {
  const service = useService(WorkspaceContentOperationService);
  const navigate = useNavigateHelper();
  const t = useI18n();
  const [collapsed, setCollapsed] = useState(true);
  const [folder, setFolder] = useState<Folder | null>();
  const address = JSON.stringify([workspaceId, folderId]);
  const cycle = ancestors.includes(address);
  const unavailable =
    t["com.myoxus.workspace-content-operation.error.target-denied"]();

  useEffect(() => {
    if (cycle || (collapsed && name !== undefined)) return;
    let active = true;
    let pending = false;
    async function refresh() {
      if (pending || document.hidden) return;
      pending = true;
      try {
        const result = await service.linkedFolder(
          workspaceId,
          folderId,
          !collapsed,
        );
        if (active) setFolder(result);
      } catch {
        if (active) setFolder(null);
      } finally {
        pending = false;
      }
    }
    void refresh();
    document.addEventListener("visibilitychange", refresh);
    const timer = collapsed ? undefined : window.setInterval(refresh, 30_000);
    return () => {
      active = false;
      document.removeEventListener("visibilitychange", refresh);
      window.clearInterval(timer);
    };
  }, [collapsed, cycle, folderId, name, service, workspaceId]);

  async function open(entry: Folder["children"][number]) {
    try {
      if (entry.rowType === "workspace") {
        const owner = await service.resolveWorkspaceHome(entry.workspaceId);
        if (owner) {
          navigate.jumpToWorkspaceOverview(owner);
          return;
        }
      } else if (isCrossWorkspaceResourceKind(entry.rowType)) {
        const resource = await service.resolveRedirect({
          workspaceId: entry.workspaceId,
          resource: {
            id: entry.id,
            kind: CROSS_WORKSPACE_RESOURCE_KINDS[entry.rowType],
          },
        });
        if (resource) {
          navigate.jumpToWorkspaceResource(resource);
          return;
        }
      }
    } catch {
      // Opening rechecks the target even when its label is already on screen.
    }
    notify.error({ title: unavailable });
  }

  function changeCollapsed(next: boolean) {
    setFolder(undefined);
    setCollapsed(next);
  }

  return (
    <TreeNode
      name={
        folder === null
          ? unavailable
          : (folder?.name ?? name ?? t["com.myoxus.loading"]())
      }
      icon={collapsed ? FolderIcon : FolderOpenIcon}
      operations={operations}
      collapsed={collapsed}
      collapsible={!cycle}
      disabled={cycle}
      setCollapsed={changeCollapsed}
      onClick={cycle ? undefined : () => changeCollapsed(!collapsed)}
      postfix={linked ? <LinkIcon aria-hidden="true" /> : undefined}
      childrenPlaceholder={
        folder === undefined
          ? t["com.myoxus.loading"]()
          : folder === null
            ? unavailable
            : folder.children.length === 0
              ? t["com.myoxus.rootAppSidebar.organize.empty-folder"]()
              : undefined
      }
    >
      {!collapsed &&
        folder?.children.map((entry) => {
          const key = JSON.stringify([
            entry.workspaceId,
            entry.rowType,
            entry.id,
          ]);
          if (entry.rowType === "folder" || entry.rowType === "folder_link") {
            return (
              <LinkedFolderNode
                key={key}
                treeNode={TreeNode}
                workspaceId={entry.workspaceId}
                folderId={entry.id}
                linked={entry.rowType === "folder_link"}
                name={entry.name}
                ancestors={[...ancestors, address]}
              />
            );
          }
          return (
            <TreeNode
              key={key}
              name={
                entry.name ||
                (entry.rowType === "workspace"
                  ? t["com.myoxus.settings.workspace"]()
                  : t["Untitled"]())
              }
              icon={
                isCrossWorkspaceResourceKind(entry.rowType)
                  ? icons[entry.rowType]
                  : CloudWorkspaceIcon
              }
              collapsed
              collapsible={false}
              setCollapsed={() => {}}
              onClick={() => void open(entry)}
            />
          );
        })}
    </TreeNode>
  );
}
