import type { FeatureFlagService } from "@myoxus/core/modules/feature-flag";
import { toArrayBuffer } from "@myoxus/core/utils/array-buffer";
import { Entity, LiveData, yjsGetPath } from "@myoxus/infra";
import type { Workspace as WorkspaceInterface } from "@virgultum/editor/store";
import type { Observable } from "rxjs";
import { Doc as YDoc, transact } from "yjs";

import { DocsService } from "../../doc/services/docs";
import { WorkspaceImpl } from "../impls/workspace";
import type { WorkspaceScope } from "../scopes/workspace";
import { WorkspaceEngineService } from "../services/engine";
import { WorkspaceListService } from "../services/list";

export class Workspace extends Entity {
  constructor(
    public readonly scope: WorkspaceScope,
    public readonly featureFlagService: FeatureFlagService,
    workspaceListService: WorkspaceListService,
  ) {
    super();

    if (this.flavour !== "local") {
      const subscription = workspaceListService.list
        .workspace$(this.id)
        .subscribe((metadata) => {
          if (metadata?.name !== undefined) {
            this.setAuthoritativeServerName(metadata.name);
          }
        });
      this.disposables.push(() => subscription.unsubscribe());
    }
  }

  readonly id = this.scope.props.openOptions.metadata.id;

  readonly openOptions = this.scope.props.openOptions;

  readonly meta = this.scope.props.openOptions.metadata;

  readonly flavour = this.meta.flavour;

  readonly rootYDoc = new YDoc({ guid: this.openOptions.metadata.id });

  _docCollection: WorkspaceInterface | null = null;

  get docCollection() {
    if (!this._docCollection) {
      this._docCollection = new WorkspaceImpl({
        id: this.openOptions.metadata.id,
        rootDoc: this.rootYDoc,
        featureFlagService: this.featureFlagService,
        blobSource: {
          get: async (key) => {
            const record = await this.engine.blob.get(key);
            return record
              ? new Blob([toArrayBuffer(record.data)], { type: record.mime })
              : null;
          },
          delete: async () => {
            return;
          },
          list: async () => {
            return [];
          },
          set: async (id, blob) => {
            await this.engine.blob.set({
              key: id,
              data: new Uint8Array(await blob.arrayBuffer()),
              mime: blob.type,
            });
            return id;
          },

          blobState$: (key) => this.engine.blob.blobState$(key),
          upload: (key) => this.engine.blob.upload(key),
          name: "blob",
          readonly: false,
        },
        onLoadDoc: (doc) => this.engine.doc.connectDoc(doc),
        onLoadAwareness: (awareness) =>
          this.engine.awareness.connectAwareness(awareness),
        onCreateDoc: (docId) =>
          this.docs.createDoc({ id: docId, skipInit: true }).id,
      });
    }
    return this._docCollection;
  }

  get docs() {
    return this.scope.get(DocsService);
  }

  get canGracefulStop() {
    // TODO
    return true;
  }

  get engine() {
    return this.framework.get(WorkspaceEngineService).engine;
  }

  private readonly rootDocName$ = LiveData.from<string | undefined>(
    yjsGetPath(this.rootYDoc.getMap("meta"), "name") as Observable<
      string | undefined
    >,
    undefined,
  );

  private readonly serverName$ = new LiveData<string | undefined>(
    this.meta.name,
  );

  /**
   * Cloud workspace names are server metadata, not collaborative document
   * content. Keeping the Root-Yjs name as a second authority allowed an old
   * offline client to make a successfully renamed workspace look reverted on
   * every other client after reconnect. Local workspaces intentionally retain
   * their Root-Yjs-backed offline persistence.
   */
  readonly name$ =
    this.flavour === "local" ? this.rootDocName$ : this.serverName$;

  avatar$ = LiveData.from(
    yjsGetPath(this.rootYDoc.getMap("meta"), "avatar") as Observable<
      string | undefined
    >,
    undefined,
  );

  setAvatar(avatar: string) {
    transact(
      this.rootYDoc,
      () => {
        this.rootYDoc.getMap("meta").set("avatar", avatar);
      },
      { force: true },
    );
  }

  setName(name: string) {
    if (this.flavour !== "local") {
      this.setAuthoritativeServerName(name);
      return;
    }

    this.meta.name = name;
    transact(
      this.rootYDoc,
      () => {
        this.rootYDoc.getMap("meta").set("name", name);
      },
      { force: true },
    );
  }

  private setAuthoritativeServerName(name: string) {
    this.meta.name = name;
    if (this.serverName$.value !== name) {
      this.serverName$.next(name);
    }
  }

  override dispose(): void {
    this.docCollection.dispose();
  }
}
