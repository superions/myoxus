import { usesTypeOwnedMermaidDocumentHistory } from "./families/runtime/gfx-owner-hooks.js";
import { ensureMermaidProjectionOwnerCommand } from "./commands.js";
import {
  detectMermaidDiagramType,
  isMermaidFamilyVisualEditingDiagramType,
} from "./families/runtime/gfx-host-contract.js";
import { isMermaidProductDiagramType } from "./engine/product-types.js";
import {
  projectMermaidViewSourceWithoutTitle,
  resolveMermaidDiagramTitle,
} from "./engine/diagram-title.js";
import { getMermaidFamilyRuntime } from "./families/runtime/registry.js";
import { resolveMermaidSourceLifecycle } from "./families/runtime/source-lifecycle.js";
import {
  beginMermaidRuntimeTransaction,
  commitMermaidRuntimeTransaction,
  type MermaidRuntimeTransactionOptions,
} from "./families/runtime/transaction.js";
import type { MermaidShellMode } from "./families/runtime/shell-contract.js";

import { type MermaidDisplayMode } from "./mermaid-block-constants.js";

import {
  clearMermaidGfxSelectionPatch,
  type MermaidGfxSelectionPatch,
} from "./mermaid-gfx-selection-state.js";
import {
  clampMermaidVisualViewportHeight,
  resolveMermaidVisualViewportHeight,
} from "./families/runtime/gfx-host-contract.js";

import {
  MERMAID_RENDER_DEBOUNCE_MS,
  resolveMermaidStaticRenderDecision,
} from "./mermaid-render-state.js";

import { writeMermaidSourceModelState } from "./mermaid-source-write.js";
import {
  resolveMermaidShellMode,
  resolveMermaidShellModeTransition,
} from "./mermaid-view-mode-state.js";

import { renderMermaidSvg } from "./renderer.js";
import {
  coerceMermaidBlockText,
  getMermaidBlockSource,
  normalizeMermaidSourceInput,
} from "./utils.js";

type MermaidControlSourceMutationOptions = MermaidRuntimeTransactionOptions & {
  readonly templateId?: string;
};
import { MermaidHostLifecycle } from "./mermaid-host-lifecycle.js";

function concreteMermaidRenderError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/^Error:\s*/i, "")
    .split(/\n\s+at\s+/u, 1)[0]
    .trim()
    .slice(0, 800);
}

export abstract class MermaidHostSource extends MermaidHostLifecycle {
  private _renderGeneration = 0;
  private _readonlyShellMode: MermaidShellMode | null = null;

  protected _canExploreReadonly() {
    const { resolution } = resolveMermaidSourceLifecycle(
      getMermaidBlockSource(this.model.props),
    );
    return (
      resolution.kind === "resolved" &&
      resolution.capabilities.readonlyExploration === true
    );
  }

  protected _getShellMode(viewMode = this._mode): MermaidShellMode {
    return resolveMermaidShellMode({
      displayMode: this._getDisplayMode(),
      viewMode,
    });
  }

  protected _setShellMode(mode: MermaidShellMode) {
    if (this.store.readonly && this._canExploreReadonly()) {
      // Reader navigation is transient: no displayMode write or semantic history.
      this._readonlyShellMode = mode;
      if (mode !== "view") this._mode = mode;
      this._cancelPageSelectionMode();
      this._clearPendingVisualSelectionProjection();
      this._scheduleRender();
      this.requestUpdate();
      return;
    }
    const currentMode = this._getShellMode();
    const transition = resolveMermaidShellModeTransition({
      currentDisplayMode: this._getDisplayMode(),
      currentViewMode: this._mode,
      isConnected: this.isConnected,
      isReadonly: this.store.readonly,
      nextMode: mode,
    });
    if (!transition) return;
    // Retain explicit navigation if rights disappear in this editing session.
    // Fresh snapshot readers still have no session preference and start in View.
    this._readonlyShellMode = this._canExploreReadonly() ? mode : null;
    if (currentMode === "visual" && mode !== "visual") {
      this._cancelPageSelectionMode();
      this._clearPendingVisualSelectionProjection();
    }
    const enteringVisual = currentMode === "source" && mode === "visual";
    if (transition.scheduleProjectionOwnerSourceSync) {
      this._scheduleProjectionOwnerSourceSync();
    }
    if (transition.clearPendingVisualInsert) {
      this._pendingVisualInsertShape = null;
    }
    if (transition.clearVisualSelection) {
      this._clearVisualSelectionState();
    }
    if (enteringVisual && !this.store.readonly) {
      this._pauseProjectionOwnerSourceSync();
      this._ensureProjectionOwner(false, true);
      this._acceptProjectionOwnerSourceSyncKey();
    }
    this._mode = transition.viewMode;
    if (transition.activateKeyboardTarget) {
      this._activateKeyboardTarget();
    }
    if (transition.writeDisplayMode) {
      // View is a persisted presentation preference, not document content.
      // Keep mode switches out of the semantic undo stack so the next Undo
      // always targets the user's last diagram mutation.
      this.store.transact(() => {
        this.model.props.displayMode = transition.displayMode;
      }, false);
    }
    this._scheduleRender();
    this.requestUpdate();
  }

  protected _getDisplayMode(): MermaidDisplayMode {
    const persistedMode =
      this.model.props.displayMode === "display" ? "display" : "edit";
    if (!this.store.readonly) {
      // An editable load may already be in Visual without a mode-control click.
      // Remember that active session before a later permissions update.
      this._readonlyShellMode = resolveMermaidShellMode({
        displayMode: persistedMode,
        viewMode: this._mode,
      });
      return persistedMode;
    }
    // Snapshot/share readers use presentation without rewriting the author's
    // persisted editing preference or exposing inert mutation controls. An
    // explicitly requested Source projection remains available for reading.
    if (
      this.store.readonly &&
      this._readonlyShellMode &&
      this._canExploreReadonly()
    )
      return this._readonlyShellMode === "view" ? "display" : "edit";
    if (this.store.readonly && this._mode !== "source") return "display";
    return persistedMode;
  }

  protected _clampVisualViewportHeight(height: number) {
    return clampMermaidVisualViewportHeight(height);
  }

  protected _getVisualViewportHeight(autoHeight: number) {
    if (typeof this.model.props.viewportHeight !== "number") {
      this._visualAutoViewportHeight ??=
        this._clampVisualViewportHeight(autoHeight);
      return this._visualAutoViewportHeight;
    }
    return resolveMermaidVisualViewportHeight({
      autoHeight,
      storedHeight: this.model.props.viewportHeight,
    });
  }

  protected _setVisualViewportHeight(height: number) {
    if (this.store.readonly) return;
    const next = this._clampVisualViewportHeight(height);
    if (this.model.props.viewportHeight === next) return;
    // This is document-layout state, not diagram geometry. Persisting it on the
    // block lets users keep a compact figure in text and expand it while editing
    // large workflows without changing Mermaid source.
    this.model.props.viewportHeight = next;
    this._visualAutoViewportHeight = null;
    this._lastScopedGfxFitKey = "";
    this.requestUpdate();
  }

  protected _applyVisualSelectionPatch(patch: MermaidGfxSelectionPatch) {
    if (patch.pendingVisualInsertShape !== undefined)
      this._pendingVisualInsertShape = patch.pendingVisualInsertShape;
    if (patch.visualSelection) {
      this._visualAlignmentGuideId = "";
      this._replaceVisualSelection(
        patch.visualSelection.kind,
        patch.visualSelection.editKeys,
      );
    }
    if (patch.visualContextMenu !== undefined)
      this._visualContextMenu = patch.visualContextMenu;
    if (patch.isConnectingVisualNodes === false) {
      this._gfxSession.stopVisualNodeConnection();
    }
  }

  protected _clearVisualSelectionState() {
    this._applyVisualSelectionPatch(clearMermaidGfxSelectionPatch());
  }

  protected _scheduleRender() {
    if (this._renderTimer) clearTimeout(this._renderTimer);
    const generation = ++this._renderGeneration;
    // Invalidate the old output before the debounce, and reject async results
    // from an earlier source or mode so they cannot replace the current preview.
    this._renderState = "loading";
    this.requestUpdate();
    this._renderTimer = setTimeout(() => {
      this._renderMermaid(generation).catch((error) => {
        console.error("[mermaid:block] render failed", error);
      });
    }, MERMAID_RENDER_DEBOUNCE_MS);
  }

  protected _ensureProjectionOwner(capture = true, preferSource = false) {
    if (this.store.readonly || this._gfxSession.hasTransientGeometryPreview)
      return;
    if (
      preferSource &&
      !resolveMermaidSourceLifecycle(getMermaidBlockSource(this.model.props))
        .canReconcileProjection
    ) {
      return;
    }
    if (!preferSource && this._syncKnownProjectionOwnerDriftBeforeEnsure()) {
      return;
    }
    this.std.command.exec(ensureMermaidProjectionOwnerCommand, {
      capture,
      model: this.model,
      preferSource,
    });
    this._remapVisualSelection();
  }

  protected _setSourceFromControl(
    value: string,
    options: MermaidControlSourceMutationOptions = {},
  ) {
    const transaction = beginMermaidRuntimeTransaction({
      currentSource: getMermaidBlockSource(this.model.props),
      options,
      readonly: this.store.readonly,
    });
    if (!transaction) return;
    this.store.captureSync();
    const writeSource = () =>
      this._writeMermaidSource(
        options.preserveSourceBytes
          ? value
          : normalizeMermaidSourceInput(value),
        true,
        options.preserveSourceBytes,
      );
    // Document history must retain removed projection children with the Source
    // edit. Reconciliation outside that transaction cannot restore their IDs
    // or manual geometry when a raw edit removes every declaration.
    if (usesTypeOwnedMermaidDocumentHistory(this.model.props.diagramType))
      this.store.transact(writeSource);
    else writeSource();
    if (options.templateId) this.model.props.templateId = options.templateId;
    const commit = commitMermaidRuntimeTransaction({
      applied: true,
      currentSource: getMermaidBlockSource(this.model.props),
      owner: this.model,
      transaction,
    });
    if (commit && !commit.deferUpdate) {
      this._scheduleRender();
      this.requestUpdate();
    }
  }

  protected _writeMermaidSource(
    value: string,
    reconcileProjectionOwner = true,
    preserveSourceBytes = false,
  ) {
    this._clearPendingVisualSelectionProjection();
    this._cancelPageSelectionMode();
    if (typeof this._pauseProjectionOwnerSourceSync === "function") {
      this._pauseProjectionOwnerSourceSync();
    }
    const sourceWrite = writeMermaidSourceModelState(this.model, value, {
      preserveSourceBytes,
    });
    this._pendingVisualInsertShape = null;
    this._lastProjectionOwnerSelectionKey = "";
    // Source is the persisted semantic authority and already owns the user
    // transaction. The projection owner is a deterministic projection of that
    // source; recording its reconciliation separately would split one source
    // edit into multiple undo steps.
    const sourceIsValid = sourceWrite.canReconcileProjection;
    if (reconcileProjectionOwner && sourceIsValid) {
      this._ensureProjectionOwner(false, true);
    } else {
      this._remapVisualSelection();
    }
    if (
      sourceIsValid &&
      typeof this._acceptProjectionOwnerSourceSyncKey === "function"
    ) {
      this._acceptProjectionOwnerSourceSyncKey();
    }
    this.requestUpdate();
  }

  protected async _renderMermaid(generation: number) {
    if (generation !== this._renderGeneration) return;
    try {
      const source = normalizeMermaidSourceInput(
        getMermaidBlockSource(this.model.props),
      );
      const diagramType = source ? detectMermaidDiagramType(source) : "unknown";
      const renderDecision = resolveMermaidStaticRenderDecision({
        displayMode: this._getDisplayMode(),
        isGfxDiagramType:
          isMermaidFamilyVisualEditingDiagramType(diagramType) &&
          Boolean(this._getMermaidVisualModelForEditing()),
        source,
      });
      if (renderDecision !== "render") {
        this._svg = "";
        this._renderState = "empty";
        this._renderErrorLine = null;
        this._renderErrorMessage = null;
        return;
      }

      this._renderState = "loading";
      this.requestUpdate();
      const runtime = isMermaidProductDiagramType(diagramType)
        ? getMermaidFamilyRuntime(diagramType)
        : null;
      const effectiveTitle = isMermaidProductDiagramType(diagramType)
        ? resolveMermaidDiagramTitle({
            diagramType,
            familyTitle: runtime?.diagramTitle,
            legacyTitle: coerceMermaidBlockText(this.model.props.title),
            source,
          })
        : null;
      const renderSource =
        this._getShellMode() === "view" && effectiveTitle
          ? projectMermaidViewSourceWithoutTitle(source, effectiveTitle)
          : source;
      const result = await renderMermaidSvg(renderSource, {
        idPrefix: `myoxus-mermaid-${this.blockId}`,
      });
      if (generation !== this._renderGeneration) return;
      this._svg = result.svg;
      if (result.svg) this._lastValidSvg = result.svg;
      // A successful empty render is completed, not an unrendered source.
      // Otherwise display rendering reschedules this same empty Gantt forever.
      this._renderState = "finish";
      this._renderErrorLine = null;
      this._renderErrorMessage = null;
    } catch (error) {
      if (generation !== this._renderGeneration) return;
      this._svg = "";
      this._renderState = "error";
      const message = error instanceof Error ? error.message : String(error);
      const line = message.match(/parse error on line\s+(\d+)/i)?.[1];
      this._renderErrorLine = line ? Number(line) : null;
      this._renderErrorMessage = concreteMermaidRenderError(error);
    } finally {
      if (generation === this._renderGeneration) this.requestUpdate();
    }
  }
}
