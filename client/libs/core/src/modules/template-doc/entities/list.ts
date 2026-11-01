import { Entity, LiveData } from "@myoxus/infra";
import { firstValueFrom } from "rxjs";

import type { DocsService } from "../../doc";
import type { TemplateDocListStore } from "../store/list";

const isTemplateState = (value: unknown) => value === true || value === "true";

export class TemplateDocList extends Entity {
  constructor(
    public listStore: TemplateDocListStore,
    public docsService: DocsService,
  ) {
    super();
  }

  public isTemplate$(docId: string) {
    // DocRecord already projects server template attribution and local flags
    // through the correct workspace owner. The local-only catalog cannot
    // answer whether an open server-backed source is a template document.
    return LiveData.computed((get) => {
      const doc = get(this.docsService.list.doc$(docId));
      return doc ? get(doc.isTemplate$) : false;
    });
  }

  /** Read the hydrated native template marker at an application boundary. */
  public async isTemplate(docId: string): Promise<boolean> {
    const states = await firstValueFrom(
      this.docsService.propertyValues$("isTemplate"),
    );
    return isTemplateState(states.get(docId));
  }

  // This existing native-property projection hydrates authoritative server
  // metadata on demand and observes local properties offline. The picker must
  // not query TemplateDocListStore for cloud workspaces: that store is
  // intentionally local-only and would make managed server templates vanish.
  private readonly templateStates$ = LiveData.from(
    this.docsService.propertyValues$("isTemplate"),
    new Map<string, string | undefined>(),
  );

  public readonly templateOrigins$ = LiveData.from(
    this.docsService.templateOriginValues$(),
    new Map<string, string | undefined>(),
  );

  public readonly templateDocs$ = LiveData.computed((get) =>
    get(this.docsService.list.docs$).filter(
      (doc) =>
        isTemplateState(get(this.templateStates$).get(doc.id)) &&
        !get(doc.trash$),
    ),
  );

  public readonly templateDocIds$ = this.templateDocs$.map((docs) =>
    docs.map((doc) => doc.id),
  );

  public getTemplateDocs() {
    const templateStates = this.templateStates$.value;
    return this.docsService.list.docs$.value.filter(
      (doc) => isTemplateState(templateStates.get(doc.id)) && !doc.trash$.value,
    );
  }
}
