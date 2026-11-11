// SPDX-License-Identifier: AGPL-3.0-or-later
import { LiveData } from "@myoxus/infra";
import type { DocMode } from "@virgultum/editor/model";
import {
  computed,
  signal,
  type ReadonlySignal,
  type Signal,
} from "@preact/signals-core";
import type { DocEmbedProvider } from "@virgultum/editor/shared/services";
import { createSignalFromObservable } from "@virgultum/editor/shared/utils";
import { GuardService } from "../../permissions/services/guard";
import { DocsService } from "./docs";
import { WorkspaceContentOperationService } from "../../workspace-content-operation";
import { WorkspaceContentResourceKindType } from "@myoxus/graphql";
import { WorkspacesService, type Workspace } from "../../workspace";

type ReferenceBinding = ReturnType<
  NonNullable<DocEmbedProvider["openReference"]>
>;

/** Core-owned access and loading for editor previews, imports and exports.
 * The caller disposes subscriptions at the end of its host or operation lifetime.
 */
export class CoreDocEmbedProvider implements DocEmbedProvider {
  readonly #permissions = new Map<string, Signal<boolean | undefined>>();
  readonly #titles = new Map<string, ReadonlySignal<string | undefined>>();
  readonly #modes = new Map<string, ReadonlySignal<DocMode | undefined>>();
  readonly #cleanups: (() => void)[] = [];
  #disposed = false;

  constructor(
    private readonly guard: GuardService,
    private readonly docs: DocsService,
    private readonly workspace: Workspace,
  ) {}

  inWorkspace(workspaceId: string) {
    if (workspaceId === this.workspace.id) {
      return {
        access: this,
        collection: this.workspace.docCollection,
        dispose: () => {},
      };
    }
    const opened = this.workspace.scope
      .get(WorkspacesService)
      .openByWorkspaceId(workspaceId);
    if (!opened) return;
    const access = new CoreDocEmbedProvider(
      opened.workspace.scope.get(GuardService),
      opened.workspace.scope.get(DocsService),
      opened.workspace,
    );
    let released = false;
    const dispose = () => {
      if (released) return;
      released = true;
      access.dispose();
      opened.dispose();
      const index = this.#cleanups.indexOf(dispose);
      if (index >= 0) this.#cleanups.splice(index, 1);
    };
    // The host lifetime is the final fence if a renderer/import is interrupted.
    this.#cleanups.push(dispose);
    return { access, collection: opened.workspace.docCollection, dispose };
  }

  openReference(
    workspaceId: string | undefined,
    docId: string,
  ): ReferenceBinding {
    const target = signal<ReferenceBinding["target"]["value"]>(undefined);
    const sourceWorkspaceId = workspaceId ?? this.workspace.id;
    const source = this.inWorkspace(sourceWorkspaceId);
    let current: ReturnType<CoreDocEmbedProvider["inWorkspace"]>;
    let watchTarget: (() => void) | undefined;
    let generation = 0;
    let released = false;
    const resolve = async () => {
      const attempt = ++generation;
      watchTarget?.();
      watchTarget = undefined;
      current?.dispose();
      current = undefined;
      target.value = undefined;
      if (!source) {
        target.value = null;
        return;
      }
      const access = source.access;
      try {
        // A live local address outranks historical redirects. The server owns
        // absence/redirect resolution; a denied result never adopts another key.
        const record = access.docs.list.doc$(docId).value;
        const address =
          record || access.workspace.flavour === "local"
            ? { workspaceId: sourceWorkspaceId, id: docId }
            : await access.workspace.scope
                .get(WorkspaceContentOperationService)
                .resolveRedirect({
                  workspaceId: sourceWorkspaceId,
                  resource: {
                    kind: WorkspaceContentResourceKindType.Document,
                    id: docId,
                  },
                });
        if (released || generation !== attempt) return;
        if (!address) {
          target.value = null;
          return;
        }
        current = access.inWorkspace(address.workspaceId);
        if (!current) {
          target.value = null;
          return;
        }
        const canonical = current;
        target.value = {
          access: canonical.access,
          collection: canonical.collection,
          docId: address.id,
        };
        let present = !!canonical.access.docs.list.doc$(address.id).value;
        const subscription = canonical.access.docs.list
          .doc$(address.id)
          .subscribe((record) => {
            const next = !!record;
            const departed = present && !next;
            present = next;
            if (departed && !released) void resolve();
          });
        watchTarget = () => subscription.unsubscribe();
      } catch {
        if (!released && generation === attempt) target.value = null;
      }
    };
    const subscription = source?.access.docs.list.doc$(docId).subscribe(() => {
      void resolve();
    });
    if (!source) target.value = null;
    const dispose = () => {
      if (released) return;
      released = true;
      generation++;
      subscription?.unsubscribe();
      watchTarget?.();
      current?.dispose();
      source?.dispose();
      const index = this.#cleanups.indexOf(dispose);
      if (index >= 0) this.#cleanups.splice(index, 1);
    };
    this.#cleanups.push(dispose);
    return { target, dispose };
  }

  primaryMode(docId: string) {
    const existing = this.#modes.get(docId);
    if (existing) return existing;
    const { signal, cleanup } = createSignalFromObservable(
      this.docs.list.primaryMode$(docId),
      undefined,
    );
    this.#cleanups.push(cleanup);
    const readable = this.readable(docId);
    const projection = computed(() =>
      readable.value === true ? signal.value : undefined,
    );
    this.#modes.set(docId, projection);
    return projection;
  }

  #observePermission(docId: string) {
    const existing = this.#permissions.get(docId);
    if (existing) return existing;
    const { signal, cleanup } = createSignalFromObservable(
      this.guard.can$("Doc_Read", docId),
      undefined,
    );
    this.#permissions.set(docId, signal);
    this.#cleanups.push(cleanup);
    return signal;
  }

  readable(docId: string): ReadonlySignal<boolean | undefined> {
    if (this.#disposed) return signal(false);
    const existing = this.#permissions.get(docId);
    if (existing) return existing;
    const permission = this.#observePermission(docId);
    // A failed permission request must reach the existing error state rather
    // than waiting indefinitely. One awaited read request primes the observed
    // projection too; a second background revalidation would duplicate it.
    void this.canRead(docId).then(
      (granted) => {
        if (this.#permissions.has(docId)) permission.value = granted;
      },
      () => {
        if (this.#permissions.has(docId)) permission.value = false;
      },
    );
    return permission;
  }

  async canRead(docId: string) {
    const granted = await this.guard.can("Doc_Read", docId);
    if (this.#disposed) return false;
    // Fresh reads prime the same live projection used by capture/delivery
    // fences. Observing it must not issue the same request again.
    this.#observePermission(docId).value = granted;
    return granted;
  }

  referenceTitleSignal(docId: string) {
    const existing = this.#titles.get(docId);
    if (existing) return existing;
    const title$ = LiveData.computed((get) => {
      const record = get(this.docs.list.doc$(docId));
      return record && !get(record.trash$) ? get(record.title$) : undefined;
    });
    const { signal, cleanup } = createSignalFromObservable(title$, undefined);
    this.#cleanups.push(cleanup);
    const readable = this.readable(docId);
    const projection = computed(() =>
      readable.value === true ? signal.value : undefined,
    );
    this.#titles.set(docId, projection);
    return projection;
  }

  async referenceTitle(docId: string) {
    if (!(await this.canRead(docId))) return;
    const record = this.docs.list.doc$(docId).value;
    if (!record || record.trash$.value) return;
    // Reuse the existing title-intent projection while its server acknowledgement
    // is pending; never substitute a cached document body's old title.
    return record.title$.value;
  }

  async waitForLoaded(docId: string, signal: AbortSignal) {
    if (!(await this.canRead(docId)))
      throw new Error("Document embed access denied");
    signal.throwIfAborted();
    const reference = this.docs.open(docId);
    if (!reference) throw new Error("Document embed target missing");
    try {
      reference.doc.virgultumDoc.load();
      await reference.doc.waitForSyncReady(signal);
      signal.throwIfAborted();
      if (!(await this.canRead(docId)))
        throw new Error("Document embed access denied");
      const page = reference.doc.virgultumDoc;
      // The frontend can finish an empty local-cache load before the remote root arrives.
      if (!page.root && !page.meta?.trash) {
        await new Promise<void>((resolve, reject) => {
          const finish = (error?: unknown) => {
            subscription.unsubscribe();
            signal.removeEventListener("abort", onAbort);
            if (error) reject(error);
            else resolve();
          };
          const onAbort = () => finish(signal.reason);
          const subscription = page.slots.rootAdded.subscribe(() => {
            if (page.root) finish();
          });
          signal.addEventListener("abort", onAbort, { once: true });
          if (signal.aborted) onAbort();
          else if (page.root) finish();
        });
        signal.throwIfAborted();
        if (!(await this.canRead(docId)))
          throw new Error("Document embed access denied");
      }
    } finally {
      reference.release();
    }
  }

  dispose() {
    this.#disposed = true;
    this.#cleanups.splice(0).forEach((cleanup) => cleanup());
    this.#permissions.clear();
    this.#titles.clear();
    this.#modes.clear();
  }
}
