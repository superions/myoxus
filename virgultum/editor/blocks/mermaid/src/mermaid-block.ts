import { html } from "lit";

import { getMermaidVisualModelFromProjectionOwner } from "./commands.js";
import type { MermaidEditorCapabilities } from "./families/runtime/editor-capabilities.js";
import type { MermaidEditorShellProjection } from "./families/runtime/editor-capabilities.js";
import { resolveMermaidHostResolution } from "./families/runtime/host-controller.js";
import {
  getMermaidFamilyRuntime,
  resolveMermaidFamilyRuntime,
} from "./families/runtime/registry.js";
import {
  MermaidFamilyReactHostIdentifier,
  type MermaidFamilyReactHost,
} from "./families/runtime/react-host.js";
import { resolveMermaidSourceLifecycle } from "./families/runtime/source-lifecycle.js";
import { mermaidMessages } from "./i18n.js";

import { renderMermaidDisplayBody } from "./mermaid-host-display-render.js";

import { resolveMermaidShellMode } from "./mermaid-view-mode-state.js";

import { getMermaidBlockSource, getMermaidDiagramTypeLabel } from "./utils.js";
import { resolveMermaidEffectiveBlockTitle } from "./mermaid-title-projection.js";
import {
  createMermaidPageSelectionState,
  transitionMermaidPageSelectionState,
} from "./mermaid-page-selection-state.js";
import { resolveMermaidGfxProjection } from "./presentation/gfx-projection-owner.js";

import { MermaidHostFamilyRender } from "./mermaid-host-family-render.js";

export class MermaidBlockComponent extends MermaidHostFamilyRender {
  private _lastValidProjection: {
    readonly capabilities: MermaidEditorCapabilities;
    readonly diagramType: string;
  } | null = null;
  private _lastResolvedStructuredModel: unknown = null;
  private _lastValidStructuredModel: unknown = null;

  private readonly _isolateEmbeddedEdgelessEvent = (event: Event) => {
    if (
      this.store.readonly ||
      !this._canConsumeScopedGfxEvent() ||
      !this.selected$.value
    ) {
      return;
    }
    const claimed = event.composedPath().some((target) => {
      if (!(target instanceof Element)) return false;
      if (target.classList.contains("myoxus-mermaid-gfx-viewport")) {
        return true;
      }
      if (
        target instanceof HTMLElement &&
        ["button", "input", "option", "select", "textarea"].includes(
          target.tagName.toLowerCase(),
        )
      ) {
        return true;
      }
      const role = target.getAttribute("role");
      if (
        role === "button" ||
        role === "combobox" ||
        role === "listbox" ||
        role === "menu" ||
        role === "menuitem" ||
        role === "option"
      ) {
        return true;
      }
      return (
        target.hasAttribute("data-chart-axis-id") ||
        target.hasAttribute("data-chart-category-id") ||
        target.hasAttribute("data-chart-item-id") ||
        target.hasAttribute("data-chart-point-id") ||
        target.hasAttribute("data-chart-plot-id") ||
        target.getAttribute("data-myoxus-ui-role") ===
          "mermaid-embedded-title" ||
        target.getAttribute("data-myoxus-ui-role") ===
          "mermaid-flowchart-node-actions" ||
        target.getAttribute("data-myoxus-ui-role") ===
          "mermaid-flowchart-edge-actions" ||
        target.getAttribute("data-myoxus-ui-role") ===
          "mermaid-flowchart-subgraph-actions"
      );
    });
    if (claimed) event.stopPropagation();
  };

  private readonly _embeddedEdgelessActivationListener = {
    capture: true,
    handleEvent: () => {
      // The normal Note interaction owns the first selection/opening gesture.
      // Once that Note is editing, capture makes its Mermaid child active
      // before React controls can stop their own pointer event. Capture never
      // isolates the event; the inner bubble boundary below does that only
      // after the claimed chart/control has handled it.
      this._activateEmbeddedGfxEditor();
    },
  };

  protected _renderViewBody({
    hostResolution,
    source,
  }: {
    hostResolution: ReturnType<typeof resolveMermaidHostResolution>;
    source: string;
  }) {
    // Families own their display choice; editing geometry does not leak into native output.
    if (hostResolution.capabilities?.displayMode === "native-preview") {
      return renderMermaidDisplayBody({
        renderPreview: () => this._renderPreview(),
        renderState: this._renderState,
        scheduleRender: () => this._scheduleRender(),
        source,
      });
    }
    if (hostResolution.capabilities) {
      return this._renderCapabilities(hostResolution.capabilities, true).body;
    }
    if (hostResolution.pending) return null;
    if (hostResolution.staleProjection && this._lastValidProjection) {
      return this._renderLastValidProjection();
    }
    return renderMermaidDisplayBody({
      renderPreview: () => this._renderPreview(),
      renderState: this._renderState,
      scheduleRender: () => this._scheduleRender(),
      source,
    });
  }

  private _renderLastValidProjection() {
    const preview = this._lastValidProjection;
    if (!preview) return null;
    if (preview.capabilities.displayMode === "native-preview")
      return this._renderPreview();
    return this._renderCapabilities(preview.capabilities, true).body;
  }

  protected _renderVisualEditor({
    capabilities,
    staleProjection,
  }: ReturnType<typeof resolveMermaidHostResolution>) {
    if (capabilities) return this._renderCapabilities(capabilities);
    if (staleProjection && this._lastValidProjection) {
      return { actions: null, body: this._renderLastValidProjection() };
    }
    return { actions: null, body: null } satisfies MermaidEditorShellProjection;
  }

  private _updatePageSelectionAvailability({
    enabled,
    preserveSelection,
    preserveTool,
  }: {
    enabled: boolean;
    preserveSelection: boolean;
    preserveTool: boolean;
  }) {
    const wasEnabled = this._pageSelectionEnabled;
    this._pageSelectionEnabled = enabled;
    if (
      enabled ||
      (!wasEnabled &&
        this._pageSelectionState.tool === "pointer" &&
        !this._pageSelectionState.gestureActive &&
        (this._visualSelection.items.length === 0 || preserveSelection) &&
        !this._pendingVisualInsertShape)
    ) {
      return;
    }
    this._stopTransientPointerInteractions();
    this._pendingVisualInsertShape = null;
    this._pageSelectionState = preserveTool
      ? transitionMermaidPageSelectionState(this._pageSelectionState, {
          type: "end-gesture",
        })
      : createMermaidPageSelectionState();
    if (!preserveSelection && this._visualSelection.items.length > 0) {
      this._clearVisualSelectionState();
    }
  }

  private _renderEmbeddedEdgeless({
    hostResolution,
    reactHost,
    sourceLifecycle,
    title,
  }: {
    hostResolution: ReturnType<typeof resolveMermaidHostResolution>;
    reactHost: MermaidFamilyReactHost;
    sourceLifecycle: ReturnType<typeof resolveMermaidSourceLifecycle>;
    title: string;
  }) {
    const parent = this.store.getParent(this.model.id);
    const titleInNoteHeader =
      parent?.flavour === "myoxus:note" &&
      parent.children.length === 1 &&
      parent.children[0]?.id === this.model.id;
    const pageSelectionTools = hostResolution.capabilities?.pageSelectionTools;
    const gfxProjection = resolveMermaidGfxProjection(this.model);
    this._updatePageSelectionAvailability({
      enabled: Boolean(
        pageSelectionTools &&
        hostResolution.capabilities?.kind === "gfx" &&
        this._isActiveEmbeddedGfxEditor() &&
        gfxProjection &&
        !gfxProjection.displayOnly &&
        !hostResolution.staleProjection &&
        !hostResolution.sourceFirst &&
        !this.store.readonly,
      ),
      preserveSelection:
        this.store.readonly &&
        hostResolution.capabilities?.readonlyExploration === true &&
        !hostResolution.staleProjection &&
        !hostResolution.sourceFirst,
      preserveTool: false,
    });
    const projection: MermaidEditorShellProjection | null =
      hostResolution.capabilities
        ? this._renderCapabilities(
            hostResolution.capabilities,
            !this._canConsumeScopedGfxEvent() || !this.selected$.value,
          )
        : hostResolution.staleProjection
          ? { actions: null, body: this._renderLastValidProjection() }
          : null;
    const notice =
      projection?.notice ??
      (!hostResolution.capabilities
        ? {
            message: hostResolution.pending
              ? hostResolution.pendingReason || mermaidMessages.loading()
              : sourceLifecycle.kind === "empty"
                ? mermaidMessages.previewEmpty()
                : [
                    hostResolution.sourceFirstReason,
                    mermaidMessages.embeddedEditInPage(),
                  ]
                    .filter(Boolean)
                    .join(" "),
            title: hostResolution.pending
              ? mermaidMessages.loading()
              : hostResolution.staleProjection
                ? `${mermaidMessages.lastValidPreviewLabel()} · ${mermaidMessages.ganttReadOnly()}`
                : sourceLifecycle.kind === "invalid"
                  ? mermaidMessages.errorTitle()
                  : mermaidMessages.sourceFirstTitle(),
            tone:
              sourceLifecycle.kind === "invalid"
                ? ("error" as const)
                : ("warning" as const),
          }
        : undefined);
    // Embedded recovery consumes the same retained readonly projection as Page.
    // Its diagnostic is a notice beside that projection, never a replacement.
    const body = projection?.body;

    return html`<div
      data-mermaid-edgeless-embedded="true"
      @pointerdown=${this._embeddedEdgelessActivationListener}
    >
      <div
        @click=${this._isolateEmbeddedEdgelessEvent}
        @contextmenu=${this._isolateEmbeddedEdgelessEvent}
        @dblclick=${this._isolateEmbeddedEdgelessEvent}
        @pointerdown=${this._isolateEmbeddedEdgelessEvent}
        @wheel=${this._isolateEmbeddedEdgelessEvent}
      >
        ${reactHost.renderEmbeddedTitle({
          onActionTargetChange: this._handleFamilyHeaderActionTargetChange,
          onTitleChange: this._handleTitleChange,
          placeholder: mermaidMessages.titlePlaceholder(),
          readonly:
            this.store.readonly || !sourceLifecycle.canReconcileProjection,
          title,
          // A sole Mermaid child uses the standard Note header's Source-title
          // control. A mixed page Note instead owns a document title, so this
          // existing embedded control remains the one diagram-title projection.
          titlePresentation: {
            ...(this._familyTitlePresentationPreview ??
              hostResolution.capabilities?.titlePresentation),
            visible:
              !titleInNoteHeader &&
              (
                this._familyTitlePresentationPreview ??
                hostResolution.capabilities?.titlePresentation
              )?.visible !== false,
          },
        })}
        ${notice ? reactHost.renderShellNotice(notice) : null} ${body}
      </div>
    </div>`;
  }

  override renderBlock() {
    const title = resolveMermaidEffectiveBlockTitle(this.model.props);
    const source = getMermaidBlockSource(this.model.props);
    const readonly = this.store.readonly;
    const isInEdgelessMode =
      typeof this._isInEdgelessMode === "function" && this._isInEdgelessMode();
    const frameVisualModel = getMermaidVisualModelFromProjectionOwner(
      this.std,
      this.model,
      null,
    );
    const persistedLastValidSource =
      typeof this.model.props.lastValidSource === "string"
        ? this.model.props.lastValidSource
        : "";
    if (
      !this._lastValidStructuredModel &&
      persistedLastValidSource &&
      persistedLastValidSource !== source
    ) {
      const persisted = resolveMermaidFamilyRuntime(
        persistedLastValidSource,
        frameVisualModel,
      );
      if (persisted.kind === "resolved" && persisted.structuredModel)
        this._lastValidStructuredModel = persisted.structuredModel;
    }
    const sourceLifecycle = resolveMermaidSourceLifecycle(
      source,
      this._lastResolvedStructuredModel ?? this._lastValidStructuredModel,
    );
    const initialFamilyResolution = sourceLifecycle.resolution;
    const currentFamilyResolution =
      initialFamilyResolution.kind === "resolved" &&
      initialFamilyResolution.gfxVisualModel
        ? resolveMermaidFamilyRuntime(
            source,
            this._getMermaidVisualModelForEditing(),
            this._lastResolvedStructuredModel ?? this._lastValidStructuredModel,
          )
        : initialFamilyResolution;
    if (
      currentFamilyResolution.kind === "resolved" &&
      currentFamilyResolution.structuredModel
    ) {
      // A locally recoverable source error must not reset semantic identities
      // to an older valid projection. This model is transient reconciliation
      // context only; lastValidSource remains the persistence/recovery owner.
      this._lastResolvedStructuredModel =
        currentFamilyResolution.structuredModel;
    }
    if (
      currentFamilyResolution.kind === "resolved" &&
      sourceLifecycle.canRetainAsLastValid
    ) {
      this._lastValidProjection = {
        capabilities: currentFamilyResolution.capabilities,
        diagramType: currentFamilyResolution.diagramType,
      };
      this._lastValidStructuredModel =
        currentFamilyResolution.structuredModel ?? null;
    } else {
      const persistedLastValidResolution = persistedLastValidSource
        ? resolveMermaidFamilyRuntime(
            persistedLastValidSource,
            frameVisualModel,
          )
        : null;
      if (persistedLastValidResolution?.kind === "resolved") {
        this._lastValidProjection = {
          capabilities: persistedLastValidResolution.capabilities,
          diagramType: persistedLastValidResolution.diagramType,
        };
      } else if (frameVisualModel) {
        const runtime = getMermaidFamilyRuntime(frameVisualModel.diagramType);
        const projectPreview = runtime?.hostAdapter?.projectPreview;
        if (projectPreview) {
          this._lastValidProjection = {
            capabilities: projectPreview(frameVisualModel, source),
            diagramType: frameVisualModel.diagramType,
          };
        }
      }
    }
    const staleProjection =
      (sourceLifecycle.kind === "empty" ||
        sourceLifecycle.kind === "invalid") &&
      Boolean(this._lastValidProjection);
    let hostResolution = resolveMermaidHostResolution(currentFamilyResolution, {
      sourceState: sourceLifecycle.kind,
      staleProjection,
    });
    if (sourceLifecycle.kind === "invalid") {
      const runtime =
          currentFamilyResolution.runtime ??
          (frameVisualModel
            ? getMermaidFamilyRuntime(frameVisualModel.diagramType)
            : null),
        invalid = runtime?.hostAdapter?.projectInvalidSource?.(
          source,
          frameVisualModel,
        );
      if (invalid) {
        hostResolution = {
          ...hostResolution,
          capabilities: invalid,
          sourceFirst: false,
        };
      }
    }
    // Invalid Source keeps its corrective editor and the last valid readonly
    // projection reachable. Losing runtime capabilities must not erase the
    // user's View/Visual navigation while that projection still exists.
    const sourceFirst = hostResolution.sourceFirst && !staleProjection;
    const usesGfxOnlyDiagram = Boolean(
      (currentFamilyResolution.kind === "resolved" &&
        currentFamilyResolution.capabilities.kind === "gfx") ||
      this._lastValidProjection?.capabilities.kind === "gfx",
    );
    const mode = resolveMermaidShellMode({
      displayMode: this._getDisplayMode(),
      viewMode: sourceFirst ? "source" : this._mode,
    });
    const reactHost =
      this.std?.getOptional?.(MermaidFamilyReactHostIdentifier) ?? null;
    if (!reactHost) {
      throw new Error(
        "MermaidFamilyReactHost is required for the editor shell",
      );
    }
    if (isInEdgelessMode) {
      return this._renderEmbeddedEdgeless({
        hostResolution,
        reactHost,
        sourceLifecycle,
        title,
      });
    }
    const pageSelectionTools = hostResolution.capabilities?.pageSelectionTools;
    const pageSelectionEnabled = Boolean(
      pageSelectionTools &&
      mode === "visual" &&
      !readonly &&
      !sourceFirst &&
      !staleProjection,
    );
    this._updatePageSelectionAvailability({
      enabled: pageSelectionEnabled,
      // Reader selection opens family-owned readback (for example a comment),
      // while pageSelectionEnabled and the mutation guards remain false.
      preserveSelection:
        !sourceFirst &&
        (!readonly ||
          hostResolution.capabilities?.readonlyExploration === true),
      preserveTool: mode === "visual" && !readonly && !sourceFirst,
    });
    const projection =
      mode === "visual"
        ? this._renderVisualEditor(hostResolution)
        : ({
            actions: null,
            body:
              mode === "view"
                ? this._renderViewBody({ hostResolution, source })
                : null,
          } satisfies MermaidEditorShellProjection);
    const bodyNotice =
      projection.notice ??
      (hostResolution.pending
        ? {
            message: hostResolution.pendingReason || "",
            title: mermaidMessages.loading(),
            tone: "warning" as const,
          }
        : hostResolution.sourceFirst
          ? {
              message:
                sourceLifecycle.kind === "empty"
                  ? mermaidMessages.previewEmpty()
                  : hostResolution.sourceFirstReason ||
                    mermaidMessages.sourceFirstCopy(),
              title: staleProjection
                ? `${mermaidMessages.lastValidPreviewLabel()} · ${mermaidMessages.ganttReadOnly()}`
                : mermaidMessages.sourceFirstTitle(),
              tone: "warning" as const,
            }
          : mode === "visual"
            ? undefined
            : mode === "view" && hostResolution.capabilities
              ? this._renderState === "error"
                ? this._getPreviewNotice()
                : hostResolution.capabilities?.displayMode === "native-preview"
                  ? this._getPreviewNotice()
                  : undefined
              : mode === "source" && usesGfxOnlyDiagram && !sourceFirst
                ? undefined
                : this._getPreviewNotice());
    return reactHost.renderBlockShell({
      actions: projection.actions,
      body: projection.body,
      bodyNotice,
      canRedo:
        mode !== "view" &&
        !readonly &&
        (this._visualRedoStack.length > 0 || this.store.canRedo),
      canUndo:
        mode !== "view" &&
        !readonly &&
        (this._visualUndoStack.length > 0 || this.store.canUndo),
      emptyVisual:
        mode === "visual" &&
        !hostResolution.capabilities &&
        !hostResolution.pending &&
        !hostResolution.sourceFirst
          ? {
              onBlankDiagram: this._handleBlankDiagram,
              onFileImport: this._handleFileImport,
              onImportClick: this._handleImportClick,
              onPasteSource: this._handlePasteSource,
            }
          : undefined,
      focused: this.selected$.value,
      labels: {
        ariaBlock: mermaidMessages.ariaBlock(),
        controls: mermaidMessages.controlsLabel(),
        editor: mermaidMessages.editorLabel(),
        emptyBlank: mermaidMessages.emptyBlank(),
        emptyImport: mermaidMessages.emptyImport(),
        emptyPaste: mermaidMessages.emptyPaste(),
        previewEmpty: mermaidMessages.previewEmpty(),
        pageZoom: mermaidMessages.pageZoom(),
        pageZoomAuto: mermaidMessages.pageZoomAuto(),
        pageZoomHelp: mermaidMessages.pageZoomHelp(),
        pageZoomPercent: (percent) => mermaidMessages.pageZoomPercent(percent),
        pageCenter: mermaidMessages.pageCenter(),
        pageSelectionBox: mermaidMessages.pageSelectionBox(),
        pageSelectionPointer: mermaidMessages.pageSelectionPointer(),
        pageSelectionTools: mermaidMessages.pageSelectionTools(),
        source: mermaidMessages.modeSource(),
        sourcePlaceholder: mermaidMessages.sourcePlaceholder(),
        sourcePreview: mermaidMessages.sourcePreviewLabel(),
        titlePlaceholder: mermaidMessages.titlePlaceholder(),
        view: mermaidMessages.displayView(),
        visual: mermaidMessages.modeVisual(),
      },
      mode,
      modeDisabled: readonly && !this._canExploreReadonly(),
      pageViewport: this._pageViewportState,
      pageSelection: this._getPageSelectionProjection(),
      pageZoom: this._pageViewportState.zoom,
      pageZoomDisabled: mode === "source",
      pageCenterDisabled:
        mode === "source" ? true : !this._pageViewportState.available[mode],
      onActionTargetChange: this._handleFamilyActionTargetChange,
      onHeaderActionTargetChange: this._handleFamilyHeaderActionTargetChange,
      onBlockKeydown: (event) => this._handleBlockKeydown(event),
      onModeChange: (nextMode) => this._setShellMode(nextMode),
      onPageCenter: () =>
        mode === "source" ? undefined : this._centerPageViewport(mode),
      onPageZoomChange: (intent) => this._changePageZoom(intent),
      onRedo: this._handleRedo,
      onSelect: this._handleSelect,
      onSelectionActionInvokerChange:
        this._handlePageSelectionActionInvokerChange,
      onSourceEdit: this._handleSourceEdit,
      onTitleChange: this._handleTitleChange,
      onUndo: this._handleUndo,
      readonly,
      showView: Boolean(source.trim()) && !sourceFirst,
      showPageActions: !isInEdgelessMode,
      showPageViewportControls: !isInEdgelessMode,
      source,
      sourceFirst,
      sourceState: sourceLifecycle.kind,
      sourcePreview: usesGfxOnlyDiagram
        ? null
        : hostResolution.capabilities?.sourcePreview === "native-preview" ||
            hostResolution.capabilities?.displayMode === "native-preview"
          ? this._renderPreview()
          : staleProjection && this._lastValidProjection
            ? this._renderLastValidProjection()
            : hostResolution.capabilities
              ? this._renderCapabilities(hostResolution.capabilities, true).body
              : this._renderPreview(),
      staleProjection,
      title,
      titlePresentation:
        this._familyTitlePresentationPreview ??
        hostResolution.capabilities?.titlePresentation,
      typeLabel:
        getMermaidDiagramTypeLabel(currentFamilyResolution.diagramType) ||
        getMermaidDiagramTypeLabel(
          this._lastValidProjection?.diagramType ?? "unknown",
        ) ||
        mermaidMessages.defaultTitle(),
      usesGfxOnlyDiagram,
    });
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "myoxus-mermaid": MermaidBlockComponent;
  }
}
