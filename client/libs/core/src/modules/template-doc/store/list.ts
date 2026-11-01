import { Store } from "@myoxus/infra";
import { map, of } from "rxjs";

import type { WorkspaceDBService } from "../../db";
import type { WorkspaceService } from "../../workspace";

export class TemplateDocListStore extends Store {
  constructor(
    private readonly dbService: WorkspaceDBService,
    private readonly workspaceService: WorkspaceService,
  ) {
    super();
  }

  isTemplateDoc(docId: string) {
    if (!this.isLocalWorkspace) return false;
    return !!this.dbService.db.docProperties.find({
      id: docId,
      isTemplate: true,
    })[0]?.isTemplate;
  }

  watchTemplateDoc(docId: string) {
    if (!this.isLocalWorkspace) return of(false);
    return this.dbService.db.docProperties
      .find$({ id: docId, isTemplate: true })
      .pipe(map((res) => res[0]?.isTemplate));
  }

  getTemplateDocIds() {
    if (!this.isLocalWorkspace) return [];
    return this.dbService.db.docProperties
      .find({ isTemplate: true })
      .map((property) => property.id);
  }

  watchTemplateDocs() {
    if (!this.isLocalWorkspace) return of([]);
    return this.dbService.db.docProperties.find$({ isTemplate: true });
  }

  private get isLocalWorkspace() {
    return this.workspaceService.workspace.flavour === "local";
  }
}
