// SPDX-License-Identifier: AGPL-3.0-or-later

import type { FolderNode } from "@myoxus/core/modules/organize";

export type WorkspaceFolderOption = {
  value: string;
  label: string;
};

export function collectDatabaseFolderLinks(
  node: FolderNode,
  databaseId: string,
): FolderNode[] {
  const links: FolderNode[] = [];
  const visited = new Set<FolderNode>();
  const visit = (parent: FolderNode) => {
    if (visited.has(parent)) return;
    visited.add(parent);
    for (const child of parent.sortedChildren$.value) {
      if (
        child.type$.value === "database" &&
        child.data$.value === databaseId
      ) {
        links.push(child);
      }
      if (child.type$.value === "folder") visit(child);
    }
  };
  visit(node);
  return links;
}

export function findWorkspaceFolder(
  node: FolderNode,
  folderId: string,
): FolderNode | null {
  const visited = new Set<FolderNode>();
  const visit = (parent: FolderNode): FolderNode | null => {
    if (visited.has(parent)) return null;
    visited.add(parent);
    for (const child of parent.sortedChildren$.value) {
      if (child.id === folderId && child.type$.value === "folder") return child;
      if (child.type$.value === "folder") {
        const nested = visit(child);
        if (nested) return nested;
      }
    }
    return null;
  };
  return visit(node);
}

export function collectWorkspaceFolderOptions(
  root: FolderNode,
): WorkspaceFolderOption[] {
  const options: WorkspaceFolderOption[] = [];
  const visited = new Set<FolderNode>();

  const visit = (node: FolderNode, path: readonly string[]) => {
    if (visited.has(node)) return;
    visited.add(node);
    for (const child of node.sortedChildren$.value) {
      if (child.type$.value !== "folder" || !child.id) continue;
      const name = child.name$.value;
      const nextPath = [...path, name];
      options.push({ value: child.id, label: nextPath.join(" / ") });
      visit(child, nextPath);
    }
  };

  visit(root, []);
  return options;
}

/**
 * Idempotently project a Database into one organizer folder. The Database
 * remains server-owned; this operation only converges duplicate local links.
 */
export function linkDatabasePageToFolder(
  root: FolderNode,
  databaseId: string,
  folderId: string | null,
) {
  const links = collectDatabaseFolderLinks(root, databaseId);
  if (!folderId) {
    links.forEach((link) => link.delete());
    return;
  }

  const target = findWorkspaceFolder(root, folderId);
  if (!target) throw new Error("Folder not found");

  const existingAtTarget = links.find(
    (link) => link.info$.value?.parentId === folderId,
  );
  const kept = existingAtTarget ?? links[0];
  if (kept?.id && kept.info$.value?.parentId !== folderId) {
    target.moveHere(kept.id, target.indexAt("after"));
  } else if (!kept) {
    target.createLink("database", databaseId, target.indexAt("after"));
  }
  links.filter((link) => link !== kept).forEach((link) => link.delete());
}
