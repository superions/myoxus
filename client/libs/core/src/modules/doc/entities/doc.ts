import { Entity } from "@myoxus/infra";
import type { DocMode, RootBlockModel } from "@virgultum/editor/model";
import { throttle } from "lodash-es";
import type { Transaction } from "yjs";

import type { DocProperties } from "../../db";
import type { DocumentMetadataCacheService } from "../../document-metadata/services/document-metadata-cache";
import type { WorkspaceService } from "../../workspace";
import type { DocScope } from "../scopes/doc";
import type { DocsStore } from "../stores/docs";

export class Doc extends Entity {
  constructor(
    public readonly scope: DocScope,
    private readonly store: DocsStore,
    private readonly workspaceService: WorkspaceService,
    documentMetadataCache: DocumentMetadataCacheService,
  ) {
    super();

    this.disposables.push(
      documentMetadataCache.observeSyncedVersionHead(this.id),
    );

    const updateModifiedAt = throttle(
      () => this.setUpdatedAt(Date.now()),
      1000,
      {
        leading: true,
        trailing: true,
      },
    );
    const handleTransaction = (trx: Transaction) => {
      // Reading and remote/empty transactions must neither edit metadata nor
      // consume the throttle window of a genuine local edit.
      if (!this.virgultumDoc.readonly && trx.local && trx.changed.size > 0) {
        updateModifiedAt();
      }
    };
    this.yDoc.on("afterTransaction", handleTransaction);

    this.disposables.push(() => {
      this.yDoc.off("afterTransaction", handleTransaction);
      updateModifiedAt.cancel();
    });

    this.disposables.push(
      this.workspaceService.workspace.engine.doc.addPriority(this.id, 100),
    );

    this.disposables.push(
      this.workspaceService.workspace.engine.indexer.addPriority(this.id, 100),
    );
  }

  /**
   * for convenience
   */
  get workspace() {
    return this.workspaceService.workspace;
  }

  get id() {
    return this.scope.props.docId;
  }

  public readonly yDoc = this.scope.props.virgultumDoc.spaceDoc;
  public readonly virgultumDoc = this.scope.props.virgultumDoc;
  public readonly record = this.scope.props.record;

  readonly meta$ = this.record.meta$;
  readonly properties$ = this.record.properties$;
  readonly primaryMode$ = this.record.primaryMode$;
  readonly title$ = this.record.title$;
  readonly trash$ = this.record.trash$;
  readonly createdAt$ = this.record.createdAt$;
  readonly updatedAt$ = this.record.updatedAt$;
  readonly createdBy$ = this.record.createdBy$;
  readonly updatedBy$ = this.record.updatedBy$;
  readonly journalDate$ = this.record.journalDate$;
  readonly isTemplate$ = this.record.isTemplate$;
  readonly pageWidth$ = this.record.pageWidth$;
  readonly edgelessColorTheme$ = this.record.edgelessColorTheme$;
  readonly integrationType$ = this.record.integrationType$;

  setCreatedAt(createdAt: number) {
    this.record.setMeta({ createDate: createdAt });
  }

  setUpdatedAt(updatedAt: number) {
    this.record.setMeta({ updatedDate: updatedAt });
  }

  customProperty$(propertyId: string) {
    return this.record.customProperty$(propertyId);
  }

  setProperty(propertyId: string, value: string) {
    return this.record.setProperty(propertyId, value);
  }

  updateProperties(properties: Partial<DocProperties>) {
    return this.record.updateProperties(properties);
  }

  getProperties() {
    return this.record.getProperties();
  }

  setCustomProperty(propertyId: string, value: string) {
    return this.record.setCustomProperty(propertyId, value);
  }

  setPrimaryMode(mode: DocMode) {
    return this.record.setPrimaryMode(mode);
  }

  setJournalDate(date: string | null) {
    return this.record.setJournalDate(date);
  }

  setTemplateState(isTemplate: boolean) {
    return this.record.setTemplateState(isTemplate);
  }

  setPageWidth(pageWidth: string | null) {
    return this.record.setPageWidth(pageWidth);
  }

  setEdgelessColorTheme(theme: string | null) {
    return this.record.setEdgelessColorTheme(theme);
  }

  setIntegrationType(integrationType: string | null) {
    return this.record.setIntegrationType(integrationType);
  }

  getPrimaryMode() {
    return this.record.getPrimaryMode();
  }

  togglePrimaryMode() {
    this.setPrimaryMode(
      (this.getPrimaryMode() === "edgeless" ? "page" : "edgeless") as DocMode,
    );
  }

  moveToTrash() {
    return this.record.moveToTrash();
  }

  restoreFromTrash() {
    return this.workspace.docs.restoreFromTrash(this.id);
  }

  waitForSyncReady(signal?: AbortSignal) {
    return this.store.waitForDocLoadReady(this.id, signal);
  }

  addPriorityLoad(priority: number) {
    return this.store.addPriorityLoad(this.id, priority);
  }

  changeDocTitle(newTitle: string, intentGeneration?: number) {
    const generation =
      intentGeneration ?? this.store.beginDocTitleIntent(this.id, newTitle);
    if (!this.store.isCurrentDocTitleIntent(this.id, generation)) return;
    const pageBlock = this.virgultumDoc.getBlocksByFlavour("myoxus:page").at(0)
      ?.model as RootBlockModel | undefined;
    if (pageBlock) {
      if (pageBlock.props.title.toString() !== newTitle) {
        this.virgultumDoc.transact(() => {
          pageBlock.props.title.delete(0, pageBlock.props.title.length);
          pageBlock.props.title.insert(newTitle, 0);
        });
      }
      if (!this.store.isServerBackedWorkspace()) {
        this.record.setMeta({ title: newTitle });
      }
    }
  }
}
