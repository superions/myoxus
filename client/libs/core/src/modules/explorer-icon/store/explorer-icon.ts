import { Store } from "@myoxus/infra";
import type { IconData } from "@myoxus/ui-facade";

import type { WorkspaceDBService } from "../../db";

export type ExplorerType = "collection" | "database" | "doc" | "folder" | "tag";

export class ExplorerIconStore extends Store {
  constructor(private readonly dbService: WorkspaceDBService) {
    super();
  }

  watchIcon(type: ExplorerType, id: string) {
    return this.dbService.db.explorerIcon.get$(`${type}:${id}`);
  }

  getIcon(type: ExplorerType, id: string) {
    return this.dbService.db.explorerIcon.get(`${type}:${id}`);
  }

  setIcon(options: { where: ExplorerType; id: string; icon?: IconData }) {
    const { where, id, icon } = options;
    // remove icon
    if (!icon) {
      return this.dbService.db.explorerIcon.delete(`${where}:${id}`);
    }
    // upsert icon
    return this.dbService.db.explorerIcon.create({
      id: `${where}:${id}`,
      icon,
    });
  }
}
