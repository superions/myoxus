import type { MermaidBlockModel } from "@virgultum/model";
import type { BlockStdScope } from "@virgultum/std";
import type { Query, Store } from "@virgultum/store";

import { getMermaidVisualModelForEditing } from "../commands.js";
import { resolveMermaidFamilyRuntime } from "../families/runtime/registry.js";
import type { MermaidViewMode } from "../mermaid-block-constants.js";
import { getMermaidGfxSelectionIdentity } from "../mermaid-gfx-selection.js";
import {
  isMermaidOwnerAdoptionCandidate,
  projectTypeOwnedAdoptedMermaidOwnerShape,
} from "../mermaid-owner-source-sync.js";
import { Bound } from "@virgultum/global/gfx";
import { createMermaidOwnerGfxStoreElementKey } from "../mermaid-owner-gfx-store.js";
import { getMermaidVisualModel } from "../commands/model-resolution.js";
import { projectMermaidLocalGfxAppearance } from "../mermaid-local-gfx-appearance.js";
import { canProjectMermaidNatively } from "./owner.js";
import { getMermaidBlockSource } from "../utils.js";
import {
  resolveMermaidGfxProjection,
  type MermaidGfxProjection,
} from "./gfx-projection-owner.js";
import { createMermaidOwnerGfxQuery } from "./owner-gfx-query.js";

type MermaidOwnerSurfaceSubscription = {
  dispose?: () => void;
  unsubscribe?: () => void;
};

type MermaidOwnerSurface = {
  elementAdded?: {
    subscribe?: (
      callback: (event: { id: string; local?: boolean }) => void,
    ) => MermaidOwnerSurfaceSubscription | undefined;
  };
  elementUpdated?: {
    subscribe?: (
      callback: (event: { id: string; local?: boolean }) => void,
    ) => MermaidOwnerSurfaceSubscription | undefined;
  };
  getElementById?: (id: string) => unknown;
  updateElement?: (id: string, props: Record<string, unknown>) => void;
};

export type MermaidOwnerGfxBridgeHost = {
  acceptProjectionOwnerSourceSyncKey(): void;
  getMode(): MermaidViewMode;
  getModel(): MermaidBlockModel;
  getStd(): Pick<BlockStdScope, "store" | "workspace">;
  getStore(): Store;
  hasActiveInlineTextEditor(): boolean;
  hasActivePointerSession(): boolean;
  isInEdgelessMode(): boolean;
  scheduleProjectionOwnerSourceSyncIfDrifted(): void;
};

/**
 * Owns the Mermaid projection surface watcher and scoped GFX store cache.
 *
 * The block host is still responsible for deciding when the visual editor is
 * rendered. The direct Mermaid block is authoritative. Retained linked data can
 * be queried for display only until migration, but never receives adoption or
 * GFX-to-source ownership through this bridge.
 */
export class MermaidOwnerGfxBridge {
  private ownerGfxStore: Store | null = null;
  private ownerGfxStoreElementKey = "";
  private ownerGfxStoreOwnerId = "";
  private ownerGfxStoreQuery: Query | null = null;
  private ownerSurfaceWatchKey = "";
  private projectingLocalAppearance = false;
  private surfaceRefreshRaf = 0;
  private readonly pendingLocalElementIds = new Set<string>();
  private readonly ownerSurfaceWatchDisposables: MermaidOwnerSurfaceSubscription[] =
    [];

  constructor(private readonly host: MermaidOwnerGfxBridgeHost) {}

  dispose() {
    this.clearOwnerGfxStore();
    this.clearOwnerSurfaceWatcher();
  }

  clearOwnerGfxStore() {
    const query = this.ownerGfxStoreQuery;
    this.ownerGfxStore = null;
    this.ownerGfxStoreElementKey = "";
    this.ownerGfxStoreOwnerId = "";
    this.ownerGfxStoreQuery = null;
    if (query) {
      this.host.getStore().doc.removeStore({ query });
    }
  }

  watchOwnerSurface() {
    // The block-scoped embedded consumer owns GFX -> Source reconciliation
    // through this bridge in both Page and an opened Edgeless Note. A native
    // root Edgeless owner instead uses the document-wide history/sync route.
    const model = this.host.getModel();
    const isNativeEdgelessOwner =
      this.host.isInEdgelessMode() &&
      this.host.getStore().getParent(model.id)?.flavour === "myoxus:surface";
    if (isNativeEdgelessOwner || this.host.getMode() !== "visual") {
      this.clearOwnerSurfaceWatcher();
      return;
    }

    const projection = resolveMermaidGfxProjection(model);
    if (!projection || projection.displayOnly) {
      this.clearOwnerSurfaceWatcher();
      return;
    }

    const surface = projection.owner.surface as
      MermaidOwnerSurface | null | undefined;
    if (!surface) {
      this.clearOwnerSurfaceWatcher();
      return;
    }

    const key = `${projection.ownerId}:${projection.childElementIds.join(",")}`;
    if (this.ownerSurfaceWatchKey === key) return;

    this.clearOwnerSurfaceWatcher();
    this.ownerSurfaceWatchKey = key;
    const adopt = (id: string, local = true) => {
      if (this.projectingLocalAppearance) return;
      const current = resolveMermaidGfxProjection(model);
      if (
        !current ||
        (!current.childElementIds.includes(id) &&
          !isMermaidOwnerAdoptionCandidate(
            surface.getElementById?.(id),
            current.ownerXYWH,
          ))
      )
        return;
      if (local) this.pendingLocalElementIds.add(id);
      if (this.surfaceRefreshRaf) return;
      // A shared Surface transaction may update hundreds of cells, including
      // foreign owners. Refresh this owner once and adopt only its candidates.
      this.surfaceRefreshRaf = requestAnimationFrame(() => {
        this.surfaceRefreshRaf = 0;
        const localIds = [...this.pendingLocalElementIds];
        this.pendingLocalElementIds.clear();
        // Native GFX text editors keep transient RichText/Y.Text state while
        // typing. Re-normalizing the same owner child during that window can
        // replace the editor host before the user has committed the label.
        if (
          this.host.hasActiveInlineTextEditor() ||
          this.host.hasActivePointerSession()
        ) {
          return;
        }
        this.projectOwnerLocalAppearance();
        if (localIds.length) {
          for (const id of localIds) this.adoptOwnerElement(id);
          this.host.scheduleProjectionOwnerSourceSyncIfDrifted();
        }
      });
    };
    const added = surface.elementAdded?.subscribe?.(({ id, local }) =>
      adopt(id, local),
    );
    const updated = surface.elementUpdated?.subscribe?.(({ id, local }) =>
      adopt(id, local),
    );
    if (added) this.ownerSurfaceWatchDisposables.push(added);
    if (updated) this.ownerSurfaceWatchDisposables.push(updated);
    for (const id of projection.childElementIds) {
      this.adoptOwnerElement(id);
    }
    this.projectOwnerLocalAppearance();
    // Local theme/typography projection uses stashed renderer properties but
    // still emits Surface updates. Establish the Page owner's baseline after
    // that initial projection so those deferred events cannot be mistaken for
    // a semantic user edit and rewrite otherwise unchanged Mermaid source.
    this.host.acceptProjectionOwnerSourceSyncKey();
  }

  getOwnerGfxStore(projection: MermaidGfxProjection, stateKey = "") {
    const elementKey = createMermaidOwnerGfxStoreElementKey(
      projection.childElementIds,
      stateKey,
    );
    if (
      this.ownerGfxStore &&
      this.ownerGfxStoreOwnerId === projection.ownerId &&
      this.ownerGfxStoreElementKey === elementKey
    ) {
      return this.ownerGfxStore;
    }

    this.clearOwnerGfxStore();
    const store = this.host.getStore();
    const query = createMermaidOwnerGfxQuery(projection);

    this.ownerGfxStore =
      store.workspace.getDoc(store.id)?.getStore({
        query,
      }) ?? null;
    this.ownerGfxStoreElementKey = elementKey;
    this.ownerGfxStoreOwnerId = projection.ownerId;
    this.ownerGfxStoreQuery = query;
    return this.ownerGfxStore;
  }

  private clearOwnerSurfaceWatcher() {
    if (this.surfaceRefreshRaf) cancelAnimationFrame(this.surfaceRefreshRaf);
    this.surfaceRefreshRaf = 0;
    this.pendingLocalElementIds.clear();
    for (const disposable of this.ownerSurfaceWatchDisposables) {
      disposable.dispose?.();
      disposable.unsubscribe?.();
    }
    this.ownerSurfaceWatchDisposables.length = 0;
    this.ownerSurfaceWatchKey = "";
  }

  private projectOwnerLocalAppearance() {
    if (this.projectingLocalAppearance) return;
    const model = this.host.getModel();
    const visualModel = getMermaidVisualModel(model);
    if (!visualModel) return;
    const projection = resolveMermaidGfxProjection(model);
    if (!projection || projection.displayOnly) return;
    this.projectingLocalAppearance = true;
    try {
      projectMermaidLocalGfxAppearance({
        elements: projection.childElementIds.flatMap((id) => {
          const child = projection.getElementById(id);
          return child ? [child] : [];
        }),
        frameXYWH: projection.ownerXYWH,
        visualModel,
      });
    } finally {
      this.projectingLocalAppearance = false;
    }
  }

  private adoptOwnerElement(id: string) {
    const model = this.host.getModel();
    const isNativeEdgelessOwner =
      this.host.isInEdgelessMode() &&
      this.host.getStore().getParent(model.id)?.flavour === "myoxus:surface";
    if (isNativeEdgelessOwner || this.host.getMode() !== "visual") {
      return;
    }

    const std = this.host.getStd();
    const projection = resolveMermaidGfxProjection(model);
    if (!projection || projection.displayOnly) return;

    const surface = projection.owner.surface as
      MermaidOwnerSurface | null | undefined;
    const isOwnerChild = projection.childElementIds.includes(id);
    const gfxModel = (surface?.getElementById?.(id) ??
      projection.getElementById(id)) as
      | {
          id?: string;
          type?: string;
          yMap?: {
            get?: (key: string) => unknown;
          };
        }
      | null
      | undefined;
    // Adoption only normalizes native shapes. Connector path and label updates
    // are derived GFX events; resolving the complete owner model for them
    // reads the owner's derived bound, which wakes the connector watcher and
    // creates a path -> label -> owner-bound feedback loop.
    if (gfxModel?.type !== "shape") return;

    const visualModel = getMermaidVisualModelForEditing(std, model);
    const runtimeResolution = resolveMermaidFamilyRuntime(
      getMermaidBlockSource(model.props),
      visualModel,
    );
    if (!visualModel || !canProjectMermaidNatively(runtimeResolution)) {
      return;
    }
    if (!isOwnerChild) {
      if (
        !gfxModel ||
        !isMermaidOwnerAdoptionCandidate(gfxModel, projection.ownerXYWH)
      ) {
        return;
      }
      const identity = getMermaidGfxSelectionIdentity(gfxModel);
      const alreadyManaged = projection.childElementIds.some((childId) => {
        const child = projection.getElementById(childId);
        const childIdentity = getMermaidGfxSelectionIdentity(child);
        return Boolean(
          (identity.nodeId && childIdentity.nodeId === identity.nodeId) ||
          (identity.edgeId && childIdentity.edgeId === identity.edgeId) ||
          (identity.subgraphId &&
            childIdentity.subgraphId === identity.subgraphId),
        );
      });
      if (alreadyManaged) return;
    }
    const updates = gfxModel
      ? projectTypeOwnedAdoptedMermaidOwnerShape(gfxModel, {
          ownerBound: Bound.deserialize(projection.ownerXYWH),
          visualModel,
        })
      : null;
    if (!isOwnerChild && !updates) return;
    if (updates && Object.keys(updates).length > 0 && gfxModel?.id) {
      surface?.updateElement?.(gfxModel.id, updates);
    }
    if (!isOwnerChild) {
      (
        projection.owner as { addChildren?: (models: unknown[]) => void }
      ).addChildren?.([gfxModel]);
    }
  }
}
