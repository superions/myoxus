import { Entity, LiveData } from "@myoxus/infra";
import { map } from "rxjs";

import type { FolderStore } from "../stores/folder";
import type { FolderLinkType } from "../types";
import { FolderNode } from "./folder-node";

export class FolderTree extends Entity {
  constructor(private readonly folderStore: FolderStore) {
    super();
  }

  readonly rootFolder = this.framework.createEntity(FolderNode, {
    id: null,
  });

  isLoading$ = this.folderStore.watchIsLoading();

  folderPathForLinkedDoc(docId: string) {
    return this.folderStore.folderPathForLinkedDoc(docId);
  }

  folderPathNamesForLinkedDoc$(docId: string) {
    return LiveData.from(
      this.folderStore.watchFolderPathNamesForLinkedDoc(docId),
      [],
    );
  }

  folderPathForLinkedTarget(
    type: FolderLinkType,
    targetId: string,
    targetWorkspaceId?: string,
  ) {
    return this.folderStore.folderPathForLinkedTarget(
      type,
      targetId,
      targetWorkspaceId,
    );
  }

  folderPathNamesForLinkedTarget$(
    type: FolderLinkType,
    targetId: string,
    targetWorkspaceId?: string,
  ) {
    return LiveData.from(
      this.folderStore.watchFolderPathNamesForLinkedTarget(
        type,
        targetId,
        targetWorkspaceId,
      ),
      [],
    );
  }

  removeLinksForTarget(
    type: FolderLinkType,
    targetId: string,
    targetWorkspaceId?: string,
  ) {
    this.folderStore.removeLinksForTarget(type, targetId, targetWorkspaceId);
  }

  // get folder by id
  folderNode$(id: string) {
    return LiveData.from(
      this.folderStore.watchNodeInfo(id).pipe(
        map((info) => {
          if (!info) {
            return null;
          }
          return this.framework.createEntity(FolderNode, {
            id,
          });
        }),
      ),
      null,
    );
  }
}
