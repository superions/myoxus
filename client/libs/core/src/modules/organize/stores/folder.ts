import { Store } from "@myoxus/infra";
import {
  combineLatest,
  distinctUntilChanged,
  map,
  type Observable,
  of,
  switchMap,
} from "rxjs";

import type { WorkspaceDBService } from "../../db";
import type { FolderLinkType } from "../types";

const MCP_FOLDER_INDEX_MAP = "myoxus$mcp_folder_index";
const MCP_FOLDER_INDEX_ORIGIN = "FolderStore:McpFolderIndex";
const YJS_TABLE_DELETE_FLAG = "$$DELETED";
const WORKSPACE_ROOT_TYPE = "workspace-root";

export type TemplateFolderResolution =
  | { status: "absent" | "ambiguous" }
  | { status: "resolved"; folderId: string; name: string; path: string[] };

export class FolderStore extends Store {
  constructor(private readonly dbService: WorkspaceDBService) {
    super();

    const folders = this.dbService.db.folders;
    // Hydrate before backfilling: an empty client has not established that the
    // remote index marker is missing, and writing it would echo on every reload.
    const subscription = combineLatest([
      folders.keys$(),
      folders.isReady$,
    ]).subscribe(([ids, ready]) => {
      if (ready) this.indexVisibleFolderRows(ids.filter(isNonEmptyString));
    });
    this.disposables.push(() => subscription.unsubscribe());
  }

  watchNodeInfo(nodeId: string) {
    return this.dbService.db.folders.get$(nodeId);
  }

  watchNodeChildren(parentId: string | null) {
    // Extract retains the selected folder identity as a structural root, not
    // an additional navigation level. Resolve it after remote hydration too.
    if (parentId === null) {
      return this.dbService.db.folders
        .find$({ type: WORKSPACE_ROOT_TYPE, parentId: null })
        .pipe(
          map((roots) => roots[0]?.id ?? null),
          distinctUntilChanged(),
          switchMap((rootId) =>
            this.dbService.db.folders.find$({ parentId: rootId }),
          ),
        );
    }
    return this.dbService.db.folders.find$({
      parentId: parentId,
    });
  }

  get workspaceRootId(): string | null {
    return (
      this.dbService.db.folders.find({
        type: WORKSPACE_ROOT_TYPE,
        parentId: null,
      })[0]?.id ?? null
    );
  }

  folderPathForLinkedDoc(docId: string): string[] {
    return this.folderPathForLinkedTarget("doc", docId);
  }

  /** One point-in-time placement, not the navigation helpers' first match.
   * The caller hydrates the existing folders document before taking this read.
   * Requested paths become literal document text, never feedback or logs.
   */
  resolveTemplateFolder(
    docId: string,
    explicitFolderId?: string,
    workspaceId?: string,
  ): TemplateFolderResolution {
    const links = this.dbService.db.folders
      .find({ type: "doc", data: docId })
      .filter(
        (link) =>
          !link.targetWorkspaceId || link.targetWorkspaceId === workspaceId,
      );
    if (links.length > 1) return { status: "ambiguous" };
    const folderId = links[0]?.parentId;
    if (
      !folderId ||
      (explicitFolderId !== undefined && explicitFolderId !== folderId)
    )
      return { status: "absent" };
    const path: string[] = [];
    const visited = new Set<string>();
    let current: string | null | undefined = folderId;
    while (current) {
      if (visited.has(current)) return { status: "absent" };
      visited.add(current);
      const row = this.dbService.db.folders.get(current);
      if (row?.type === WORKSPACE_ROOT_TYPE) {
        if (row.parentId || path.length === 0) return { status: "absent" };
        break;
      }
      if (!row || row.type !== "folder" || !row.data.trim())
        return { status: "absent" };
      if (row.parentId === "") return { status: "absent" };
      path.unshift(row.data.trim());
      current = row.parentId;
    }
    return { status: "resolved", folderId, name: path[path.length - 1], path };
  }

  folderPathForLinkedTarget(
    type: FolderLinkType,
    targetId: string,
    targetWorkspaceId?: string,
  ): string[] {
    const link = this.dbService.db.folders
      .find({
        type,
        data: targetId,
      })
      .find(
        (row) => !!row.parentId && row.targetWorkspaceId === targetWorkspaceId,
      );
    if (!link?.parentId) {
      return [];
    }
    return this.folderPath(link.parentId);
  }

  watchFolderPathNamesForLinkedDoc(docId: string) {
    return this.watchFolderPathNamesForLinkedTarget("doc", docId);
  }

  watchFolderPathNamesForLinkedTarget(
    type: FolderLinkType,
    targetId: string,
    targetWorkspaceId?: string,
  ) {
    return this.dbService.db.folders
      .find$({
        type,
        data: targetId,
      })
      .pipe(
        map(
          (links) =>
            links.find(
              (link) =>
                !!link.parentId && link.targetWorkspaceId === targetWorkspaceId,
            )?.parentId,
        ),
        switchMap((parentId) =>
          parentId ? this.watchFolderPathNames(parentId) : of([]),
        ),
      );
  }

  private watchFolderPathNames(
    folderId: string,
    visited = new Set<string>(),
  ): Observable<string[]> {
    if (visited.has(folderId)) {
      return of([]);
    }
    const nextVisited = new Set(visited).add(folderId);
    return this.dbService.db.folders.get$(folderId).pipe(
      switchMap((folder) => {
        if (!folder || folder.type !== "folder") {
          return of([]);
        }
        if (!folder.parentId) {
          return of([folder.data]);
        }
        return this.watchFolderPathNames(folder.parentId, nextVisited).pipe(
          map((parents) => [...parents, folder.data]),
        );
      }),
    );
  }

  watchIsLoading() {
    return this.dbService.db.folders.isLoading$;
  }

  isAncestor(childId: string, ancestorId: string): boolean {
    if (childId === ancestorId) {
      return false;
    }
    const history = new Set<string>([childId]);
    let current: string = childId;
    while (current) {
      const info = this.dbService.db.folders.get(current);
      if (info === null || !info.parentId) {
        return false;
      }
      current = info.parentId;
      if (history.has(current)) {
        return false; // loop detected
      }
      history.add(current);
      if (current === ancestorId) {
        return true;
      }
    }
    return false;
  }

  private folderPath(folderId: string): string[] {
    const path: string[] = [];
    const visited = new Set<string>();
    let current: string | null | undefined = folderId;
    while (current && !visited.has(current)) {
      visited.add(current);
      const info = this.dbService.db.folders.get(current);
      if (!info || info.type !== "folder") {
        break;
      }
      path.unshift(info.id);
      current = info.parentId;
    }
    return path;
  }

  createLink(
    parentId: string,
    type: FolderLinkType,
    nodeId: string,
    index: string,
    targetWorkspaceId?: string,
  ) {
    const parent = this.dbService.db.folders.get(parentId);
    if (parent === null || !isContainer(parent.type)) {
      throw new Error("Parent folder not found");
    }

    const link = this.dbService.db.folders.create({
      parentId,
      type,
      data: nodeId,
      index: index,
      targetWorkspaceId,
    });
    this.indexFolderRows([link.id]);
  }

  renameNode(nodeId: string, name: string) {
    const node = this.dbService.db.folders.get(nodeId);
    if (node === null) {
      throw new Error("Node not found");
    }
    if (node.type !== "folder") {
      throw new Error("Cannot rename non-folder node");
    }
    this.dbService.db.folders.update(nodeId, {
      data: name,
    });
  }

  createFolder(parentId: string | null, name: string, index: string) {
    parentId ??= this.workspaceRootId;
    if (parentId) {
      const parent = this.dbService.db.folders.get(parentId);
      if (parent === null || !isContainer(parent.type)) {
        throw new Error("Parent folder not found");
      }
    }

    const folder = this.dbService.db.folders.create({
      parentId: parentId,
      type: "folder",
      data: name,
      index: index,
    });
    this.indexFolderRows([folder.id]);
    return folder.id;
  }

  removeFolder(folderId: string) {
    const info = this.dbService.db.folders.get(folderId);
    if (info === null || info.type !== "folder") {
      throw new Error("Folder not found");
    }
    const stack = [info];
    const deletedIds: string[] = [];
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current) {
        continue;
      }
      if (current.type !== "folder") {
        this.dbService.db.folders.delete(current.id);
        deletedIds.push(current.id);
      } else {
        const children = this.dbService.db.folders.find({
          parentId: current.id,
        });
        stack.push(...children);
        this.dbService.db.folders.delete(current.id);
        deletedIds.push(current.id);
      }
    }
    this.removeFolderRowsFromIndex(deletedIds);
  }

  removeLink(linkId: string) {
    const link = this.dbService.db.folders.get(linkId);
    if (link === null || isContainer(link.type)) {
      throw new Error("Link not found");
    }
    this.dbService.db.folders.delete(linkId);
    this.removeFolderRowsFromIndex([linkId]);
  }

  removeLinksForTarget(
    type: FolderLinkType,
    targetId: string,
    targetWorkspaceId?: string,
  ) {
    const links = this.dbService.db.folders
      .find({ type, data: targetId })
      .filter((link) => link.targetWorkspaceId === targetWorkspaceId);
    for (const link of links) {
      this.dbService.db.folders.delete(link.id);
    }
    this.removeFolderRowsFromIndex(links.map((link) => link.id));
  }

  moveNode(nodeId: string, parentId: string | null, index: string) {
    const node = this.dbService.db.folders.get(nodeId);
    if (node === null) {
      throw new Error("Node not found");
    }
    if (node.type === WORKSPACE_ROOT_TYPE) {
      throw new Error("Cannot move workspace root");
    }
    // The virtual navigation root still only accepts existing folders.
    if (parentId === null && node.type !== "folder") {
      throw new Error("Root node can only have folders");
    }
    parentId ??= this.workspaceRootId;

    if (parentId) {
      if (nodeId === parentId) {
        throw new Error("Cannot move a node to itself");
      }
      if (this.isAncestor(parentId, nodeId)) {
        throw new Error("Cannot move a node to its descendant");
      }
      const parent = this.dbService.db.folders.get(parentId);
      if (parent === null || !isContainer(parent.type)) {
        throw new Error("Parent folder not found");
      }
    }
    this.dbService.db.folders.update(nodeId, {
      parentId,
      index,
    });
  }

  private indexVisibleFolderRows(ids: readonly string[]) {
    if (ids.length === 0) {
      this.ensureIndexMapIsOrmInvisible();
      return;
    }
    this.indexFolderRows(ids);
  }

  private indexFolderRows(ids: readonly string[]) {
    const ydoc = this.dbService.getWorkspaceDbDoc("folders");
    const indexMap = ydoc.getMap<boolean>(MCP_FOLDER_INDEX_MAP);
    ydoc.transact(() => {
      // This map is a root-level Y.Map in the same document as ORM rows so the
      // Rust MCP server can enumerate row ids. Marking it deleted keeps the
      // browser ORM from treating the index itself as a folder table row.
      if (indexMap.get(YJS_TABLE_DELETE_FLAG) !== true)
        indexMap.set(YJS_TABLE_DELETE_FLAG, true);
      for (const id of ids) {
        // Y.Map.set emits an update even for the same value. Remote hydration
        // must not echo an already indexed Row back as a local document edit.
        if (indexMap.get(id) !== true) indexMap.set(id, true);
      }
    }, MCP_FOLDER_INDEX_ORIGIN);
  }

  private removeFolderRowsFromIndex(ids: readonly string[]) {
    const ydoc = this.dbService.getWorkspaceDbDoc("folders");
    const indexMap = ydoc.getMap<boolean>(MCP_FOLDER_INDEX_MAP);
    ydoc.transact(() => {
      if (indexMap.get(YJS_TABLE_DELETE_FLAG) !== true)
        indexMap.set(YJS_TABLE_DELETE_FLAG, true);
      for (const id of ids) {
        if (indexMap.has(id)) indexMap.delete(id);
      }
    }, MCP_FOLDER_INDEX_ORIGIN);
  }

  private ensureIndexMapIsOrmInvisible() {
    const ydoc = this.dbService.getWorkspaceDbDoc("folders");
    const indexMap = ydoc.getMap<boolean>(MCP_FOLDER_INDEX_MAP);
    ydoc.transact(() => {
      if (indexMap.get(YJS_TABLE_DELETE_FLAG) !== true)
        indexMap.set(YJS_TABLE_DELETE_FLAG, true);
    }, MCP_FOLDER_INDEX_ORIGIN);
  }
}

function isNonEmptyString(id: unknown): id is string {
  return typeof id === "string" && id.length > 0;
}

function isContainer(type: string): boolean {
  return type === "folder" || type === WORKSPACE_ROOT_TYPE;
}
