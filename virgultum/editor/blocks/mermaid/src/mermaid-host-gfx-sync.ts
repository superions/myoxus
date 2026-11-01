import { GfxControllerIdentifier } from "@virgultum/std/gfx";

import {
  getMermaidSourceAuthoritativeVisualModel,
  getMermaidVisualModel,
  getMermaidVisualModelForEditing,
  syncMermaidVisualModelFromProjectionOwnerCommand,
} from "./commands.js";

import { isMermaidFamilyVisualEditingDiagramType } from "./families/runtime/gfx-host-contract.js";
import { createMermaidGfxModelHash } from "./families/runtime/gfx-model.js";
import {
  beginMermaidRuntimeTransaction,
  commitMermaidRuntimeTransaction,
} from "./families/runtime/transaction.js";

import { resolveMermaidGfxProjection } from "./presentation/gfx-projection-owner.js";

import {
  createMermaidProjectionOwnerSourceSyncKey,
  restoreExpectedMermaidOwnerChildrenFromActiveGfx,
} from "./mermaid-owner-source-sync.js";

import { getMermaidBlockSource } from "./utils.js";
import { resolveMermaidSourceLifecycle } from "./families/runtime/source-lifecycle.js";

import { MermaidHostGfxSelection } from "./mermaid-host-gfx-selection.js";

export abstract class MermaidHostGfxSync extends MermaidHostGfxSelection {
  /**
   * The block host is the Page consumer for owner GFX -> Source.
   * Edgeless owns that direction once per document in
   * MermaidEdgelessOwnerGfxSync; Source -> GFX projection remains shared.
   */
  private _ownsOwnerSourceSync() {
    return (
      !this._isInEdgelessMode() ||
      this.store.getParent(this.model.id)?.flavour !== "myoxus:surface"
    );
  }

  protected _scheduleProjectionOwnerSourceSync = () => {
    if (
      !this._ownsOwnerSourceSync() ||
      this._visualNodePointerSessionActive ||
      this._gfxSession.hasTransientGeometryPreview ||
      !resolveMermaidSourceLifecycle(getMermaidBlockSource(this.model.props))
        .canReconcileProjection
    ) {
      return;
    }
    if (
      this._isInlineConnectorLabelEditing ||
      this._hasActiveInlineShapeTextEditor()
    ) {
      return;
    }
    this._ownerSourceSync.schedule({
      isReadonly: this.store.readonly,
      now: performance.now(),
      syncNow: () => this._syncOwnerSourceNow(),
    });
  };

  protected _restoreExpectedMermaidProjectionOwnerChildrenFromActiveGfx() {
    const resolution = resolveMermaidGfxProjection(this.model);
    if (!resolution || resolution.displayOnly) return;
    const visualModel = getMermaidVisualModel(this.model);
    if (
      !visualModel ||
      !isMermaidFamilyVisualEditingDiagramType(visualModel.diagramType)
    ) {
      return;
    }
    const gfx = this.std.get(GfxControllerIdentifier);
    restoreExpectedMermaidOwnerChildrenFromActiveGfx({
      candidates: (gfx.gfxElements ?? []) as Array<{ id: string }>,
      projectionOwner: resolution.owner,
      visualModel,
    });
  }

  protected _syncOwnerSourceNow() {
    if (
      !this._ownsOwnerSourceSync() ||
      this._visualNodePointerSessionActive ||
      this._gfxSession.hasTransientGeometryPreview ||
      !this.isConnected ||
      this.store.readonly ||
      this.store.getBlock(this.model.id)?.model !== this.model
    ) {
      return false;
    }
    if (
      !resolveMermaidSourceLifecycle(getMermaidBlockSource(this.model.props))
        .canReconcileProjection
    ) {
      return false;
    }
    if (
      this._isInlineConnectorLabelEditing ||
      this._hasActiveInlineShapeTextEditor()
    ) {
      return false;
    }
    const beforeVisualModel = getMermaidSourceAuthoritativeVisualModel(
      this.std,
      this.model,
    );
    const transaction = beginMermaidRuntimeTransaction({
      currentSource: getMermaidBlockSource(this.model.props),
      currentVisualModel: beforeVisualModel,
      readonly: this.store.readonly,
    });
    if (!transaction) return false;
    this._restoreExpectedMermaidProjectionOwnerChildrenFromActiveGfx();
    const [, result] = this.std.command.exec(
      syncMermaidVisualModelFromProjectionOwnerCommand,
      {
        model: this.model,
      },
    );
    if (!result) return false;
    if (!result.synced) {
      this._acceptProjectionOwnerSourceSyncKey();
      if (result.visualsReprojected) {
        this._scheduleRender();
        this.requestUpdate();
      }
      return false;
    }
    // Native Edgeless tools mutate the owner projection first; recording the
    // resulting source write here lets the existing Mermaid visual undo/redo
    // path replay those user-visible edits without a parallel Edgeless history.
    commitMermaidRuntimeTransaction({
      applied: true,
      currentSource: getMermaidBlockSource(this.model.props),
      currentVisualModel: getMermaidSourceAuthoritativeVisualModel(
        this.std,
        this.model,
      ),
      owner: this.model,
      transaction,
    });
    this._acceptProjectionOwnerSourceSyncKey();
    this._scheduleRender();
    this.requestUpdate();
    return true;
  }

  protected _acceptProjectionOwnerSourceSyncKey() {
    this._ownerSourceSync.acceptKey(this._getOwnerSourceSyncKey());
  }

  protected _pauseProjectionOwnerSourceSync() {
    this._ownerSourceSync.pause(performance.now());
  }

  protected _syncKnownProjectionOwnerDriftBeforeEnsure() {
    if (
      !this._ownsOwnerSourceSync() ||
      this._visualNodePointerSessionActive ||
      this._gfxSession.hasTransientGeometryPreview ||
      !resolveMermaidSourceLifecycle(getMermaidBlockSource(this.model.props))
        .canReconcileProjection
    ) {
      return false;
    }
    if (this._isInlineConnectorLabelEditing) return false;
    const nextKey = this._getOwnerSourceSyncKey();
    const ownerModel = getMermaidVisualModelForEditing(this.std, this.model);
    const storedModel = getMermaidVisualModel(this.model);
    const ownerHash = ownerModel ? createMermaidGfxModelHash(ownerModel) : "";
    const storedHash = storedModel
      ? createMermaidGfxModelHash(storedModel)
      : "";
    return this._ownerSourceSync.syncKnownDriftBeforeEnsure({
      ownerHash,
      isReadonly: this.store.readonly,
      nextKey,
      now: performance.now(),
      storedHash,
      syncNow: () => this._syncOwnerSourceNow(),
    });
  }

  protected _reconcileProjectionOwnerFromSourceAfterHistory() {
    if (!this._ownsOwnerSourceSync()) return;
    this._lastScopedGfxFitKey = "";
    this._pauseProjectionOwnerSourceSync();
    setTimeout(() => {
      if (!this.isConnected || this.store.readonly) return;
      this._ensureProjectionOwner(false, true);
      this._acceptProjectionOwnerSourceSyncKey();
      this._ownerSourceSync.clearPause();
      this._scheduleRender();
      this.requestUpdate();
    }, 0);
  }

  protected _getOwnerSourceSyncKey() {
    return createMermaidProjectionOwnerSourceSyncKey(
      this.model,
      resolveMermaidGfxProjection(this.model),
    );
  }

  protected _scheduleProjectionOwnerSourceSyncIfDrifted() {
    if (
      !this._ownsOwnerSourceSync() ||
      this._visualNodePointerSessionActive ||
      this._gfxSession.hasTransientGeometryPreview ||
      !resolveMermaidSourceLifecycle(getMermaidBlockSource(this.model.props))
        .canReconcileProjection
    ) {
      return;
    }
    // Native GFX inline editors own transient RichText state. Syncing the
    // projection owner back into Mermaid source while they are open can re-render
    // the owner projection and interrupt typing, especially for connector labels.
    if (
      this._isInlineConnectorLabelEditing ||
      this._hasActiveInlineShapeTextEditor()
    ) {
      return;
    }
    const nextKey = this._getOwnerSourceSyncKey();
    this._ownerSourceSync.scheduleIfDrifted({
      inEdgeless: this._isInEdgelessMode(),
      isReadonly: this.store.readonly,
      mode: this._mode,
      nextKey,
      now: performance.now(),
      syncNow: () => this._syncOwnerSourceNow(),
    });
  }
}
