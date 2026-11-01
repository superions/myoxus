import { getMermaidGfxFamilyHooks } from "./families/runtime/gfx-family-hooks-registry.js";
import { type MermaidBlockModel } from "@virgultum/model";
import { BlockComponent, BlockSelection } from "@virgultum/std";
import { GfxControllerIdentifier } from "@virgultum/std/gfx";

import { getMermaidVisualModel } from "./commands.js";
import {
  MermaidGfxSessionController,
  type MermaidVisualModel,
  type MermaidVisualNodeShape,
} from "./families/runtime/gfx-host-contract.js";
import type { MermaidRuntimeTransactionOptions } from "./families/runtime/transaction.js";

import { mermaidBlockStyles } from "./mermaid-block.styles.js";
import {
  MERMAID_SCOPED_GFX_PAGE_VIEWPORT_RESIZE_STEP,
  type MermaidRenderState,
  type MermaidViewMode,
  type MermaidVisualHistoryEntry,
} from "./mermaid-block-constants.js";

import {
  MermaidGfxViewportBridge,
  type MermaidScopedGfxViewportSnapshot,
} from "./mermaid-gfx-viewport-bridge.js";
import {
  type MermaidGfxDragViewportSnapshot,
  MermaidGfxViewportInteractionController,
} from "./mermaid-gfx-viewport-interaction-controller.js";

import { MermaidInlineConnectorLabelEditorController } from "./mermaid-inline-connector-label-editor.js";
import { MermaidInlineShapeTextEditorController } from "./mermaid-inline-shape-text-editor.js";

import { MermaidOwnerGfxBridge } from "./presentation/mermaid-owner-gfx-bridge.js";

import { MermaidOwnerSourceSyncController } from "./mermaid-owner-source-sync.js";

import { getMermaidVisualHistoryStacks } from "./mermaid-visual-source-history.js";
import type { MermaidGfxSelectionPatch } from "./mermaid-gfx-selection-state.js";
import {
  createMermaidPageViewportState,
  transitionMermaidPageViewportState,
  type MermaidPageViewportTransition,
  type MermaidPageViewportMode,
  type MermaidPageViewportProjection,
  type MermaidPageZoomChangeIntent,
} from "./mermaid-page-viewport-state.js";
import {
  createMermaidPageSelectionState,
  transitionMermaidPageSelectionState,
  type MermaidPageSelectionTool,
  type MermaidPageSelectionTransition,
} from "./mermaid-page-selection-state.js";
import {
  MermaidPageSelectionController,
  type MermaidPageSelectionItem,
} from "./mermaid-page-selection-controller.js";
import {
  rememberMermaidSelection,
  pruneMermaidSelectionBookmark,
} from "./families/runtime/session-selection.js";

import type { MermaidGfxObjectEditIntent } from "./families/runtime/editor-capabilities.js";
import { readMermaidGfxMeta } from "./mermaid-gfx-metadata.js";
import { resolveMermaidGfxProjection } from "./presentation/gfx-projection-owner.js";
import { Bound } from "@virgultum/global/gfx";
export abstract class MermaidHostState extends BlockComponent<MermaidBlockModel> {
  protected _objectEditIntent:
    ((intent: MermaidGfxObjectEditIntent) => boolean) | undefined;
  protected _familyNodePointerDown:
    ((event: PointerEvent) => boolean) | undefined;
  protected _containerActionIntent: (() => boolean) | undefined;
  protected _pendingVisualNodePlacement:
    ((placement: { centerX: number; centerY: number }) => void) | null = null;
  protected _consumeVisualObjectIntent(intent: MermaidGfxObjectEditIntent) {
    const consumed =
      !this.store.readonly && Boolean(this._objectEditIntent?.(intent));
    if (consumed) {
      if (intent.kind === "detail" && intent.ownerId) {
        this._gfxViewportBridge.ensureDetailVisible(intent.ownerId, intent.id);
      }
      this.requestUpdate();
    }
    return consumed;
  }
  private _consumeVisualObjectPointerIntent(
    event: MouseEvent,
    phase: "pointer" | "edit",
  ) {
    if (
      !this._objectEditIntent ||
      this._pendingVisualNodePlacement ||
      this.store.readonly ||
      event.shiftKey ||
      event.ctrlKey ||
      event.metaKey
    )
      return false;
    const point = this._getScopedModelPointFromClient(
      event.clientX,
      event.clientY,
    );
    const projection = resolveMermaidGfxProjection(this.model);
    if (!point || !projection) return false;
    for (const id of [...projection.childElementIds].reverse()) {
      const model = projection.getElementById(id) as { xywh?: string } | null;
      const key = readMermaidGfxMeta(model, "mermaidDetailSourceKey");
      if (
        !model?.xywh ||
        !key ||
        readMermaidGfxMeta(model, "mermaidDetailKind") === "separator"
      )
        continue;
      const bound = Bound.deserialize(model.xywh);
      if (
        point.x < bound.x ||
        point.x > bound.maxX ||
        point.y < bound.y ||
        point.y > bound.maxY
      )
        continue;
      const rect = this._gfxViewportBridge.getModelViewRect(model.xywh);
      return this._consumeVisualObjectIntent({
        action:
          phase === "pointer" &&
          getMermaidGfxFamilyHooks(this._getMermaidVisualModelForEditing())
            ?.detailSelectionViaFamilyControls
            ? "select"
            : "edit",
        kind: "detail",
        id: key,
        ownerId: readMermaidGfxMeta(model, "mermaidDetailOwnerNodeId"),
        anchor: rect
          ? { left: rect.left + rect.width, top: rect.top }
          : undefined,
      });
    }
    if (phase === "pointer") return false;
    const groupId = this._findVisualSubgraphHeaderByModelPoint(
      point.x,
      point.y,
    );
    if (groupId)
      return this._consumeVisualObjectIntent({ kind: "subgraph", id: groupId });
    const edgeId = this._findVisualEdgeByModelPoint(point.x, point.y);
    if (edgeId)
      return this._consumeVisualObjectIntent({ kind: "edge", id: edgeId });
    const nodeId = this._findVisualNodeByClientPoint(
      event.clientX,
      event.clientY,
    );
    if (nodeId)
      return this._consumeVisualObjectIntent({ kind: "node", id: nodeId });
    return false;
  }

  static activeKeyboardBlock: MermaidHostState | null = null;

  static override styles = mermaidBlockStyles;

  private _getParentEdgelessNoteId() {
    return (
      this.closest("myoxus-edgeless-note") as {
        model?: { id?: string };
      } | null
    )?.model?.id;
  }

  protected _canConsumeScopedGfxEvent() {
    const noteId = this._getParentEdgelessNoteId();
    if (!noteId) return true;
    const selection = this.std.get(GfxControllerIdentifier).selection;
    return selection.has(noteId) && selection.editing;
  }

  protected _exitEmbeddedGfxEditor() {
    const noteId = this._getParentEdgelessNoteId();
    if (!noteId) return false;
    const selection = this.std.get(GfxControllerIdentifier).selection;
    if (!selection.has(noteId) || !selection.editing) return false;
    this.selection.update((selections) =>
      selections.filter(
        (item) => !(item.is(BlockSelection) && item.blockId === this.model.id),
      ),
    );
    selection.set({ editing: false, elements: [noteId] });
    return true;
  }

  protected _isActiveEmbeddedGfxEditor() {
    return (
      (!this.store.readonly || this._canExploreReadonly()) &&
      this._isInEdgelessMode() &&
      this._canConsumeScopedGfxEvent() &&
      this.selected$.value
    );
  }

  protected _claimKeyboardOwner() {
    MermaidHostState.activeKeyboardBlock = this;
  }

  protected abstract _acceptProjectionOwnerSourceSyncKey(): void;
  protected abstract _activateEmbeddedGfxEditor(): void;
  protected abstract _canExploreReadonly(): boolean;
  protected abstract _activateKeyboardTarget(): void;
  protected abstract _markScopedGfxViewportUserPositioned(): void;
  protected abstract _applyGfxMutation(
    run: () => boolean,
    options?: MermaidRuntimeTransactionOptions,
  ): boolean;
  protected abstract _applyVisualSelectionPatch(
    patch: MermaidGfxSelectionPatch,
  ): void;
  protected abstract _applyVisualSelectionGfxOperation(
    operation: "add" | "replace" | "subtract" | "toggle",
    baseIds: readonly string[],
    candidateIds: readonly string[],
  ): void;
  protected abstract _clearVisualSelection(): void;
  protected abstract _clearPageVisualSelectionFromKeyboard(): void;
  protected abstract _ensureProjectionOwner(
    capture?: boolean,
    preferSource?: boolean,
  ): unknown;
  protected abstract _findVisualEdgeByModelPoint(x: number, y: number): string;
  protected abstract _findVisualNodeByClientPoint(
    clientX: number,
    clientY: number,
  ): string;
  protected abstract _findVisualNodeModelByClientPoint(
    clientX: number,
    clientY: number,
  ): unknown;
  protected abstract _findVisualSubgraphByModelPoint(
    x: number,
    y: number,
  ): string;
  protected abstract _findVisualSubgraphHeaderByModelPoint(
    x: number,
    y: number,
  ): string;
  protected abstract _fitScopedGfxViewport(): void;
  protected abstract _fitScopedGfxViewportIfNeeded(): void;
  protected abstract _getDisplayMode(): "display" | "edit";
  protected abstract _getEditableEventTarget(event: Event): Element | null;
  protected abstract _getMermaidVisualModelForEditing(): MermaidVisualModel | null;
  protected abstract _getScopedGfxController(): ReturnType<
    MermaidGfxViewportBridge["getController"]
  >;
  protected abstract _captureScopedGfxViewport(): MermaidGfxDragViewportSnapshot | null;
  protected abstract _restoreScopedGfxViewport(
    snapshot: MermaidGfxDragViewportSnapshot | null,
  ): void;
  protected abstract _getScopedGfxViewport(): Element | null;
  protected abstract _getScopedModelPointFromClient(
    clientX: number,
    clientY: number,
  ): ReturnType<MermaidGfxViewportBridge["getModelPointFromClient"]>;
  protected abstract _getScopedModelDeltaFromClient(
    dx: number,
    dy: number,
  ): ReturnType<MermaidGfxViewportBridge["getModelDeltaFromClient"]>;
  protected abstract _panScopedGfxViewportNearClientPoint(
    clientX: number,
    clientY: number,
    maxViewDelta?: number,
  ): ReturnType<MermaidGfxViewportBridge["panViewportNearClientPoint"]>;
  protected abstract _setVisualNodePointerSessionActive(active: boolean): void;
  protected abstract _getScopedViewPointFromClient(
    clientX: number,
    clientY: number,
  ): ReturnType<MermaidGfxViewportBridge["getViewPointFromClient"]>;
  protected abstract _getVisualEdgeGfxModel(
    edgeId: string,
  ): ReturnType<MermaidGfxViewportBridge["getEdgeModel"]>;
  protected abstract _getSelectedVisualEdgeHandles(): ReturnType<
    MermaidGfxViewportBridge["getEdgeHandleViewPoints"]
  >;
  protected abstract _getSelectedVisualNodeHandles(): NonNullable<
    ReturnType<MermaidGfxViewportBridge["getNodeHandleViewPoints"]>
  >["connectPorts"];
  protected abstract _getVisualNodeConnectionHandles(
    nodeId: string,
  ): NonNullable<
    ReturnType<MermaidGfxViewportBridge["getNodeHandleViewPoints"]>
  >["connectPorts"];
  protected abstract _getVisualNodeGfxModel(
    nodeId: string,
  ): ReturnType<MermaidGfxViewportBridge["getNodeModel"]>;
  protected abstract _getVisualSubgraphGfxModel(
    subgraphId: string,
  ): ReturnType<MermaidGfxViewportBridge["getSubgraphModel"]>;
  protected abstract _handleBlockKeydown(event: KeyboardEvent): void;
  protected abstract _handleDeleteVisualSelection(): void;
  protected abstract _handleAddVisualSubgraph(): void;
  protected abstract _handleFamilySelectionAction(): void;
  protected abstract _handlePageSelectionAction(): boolean;
  protected abstract _hasFamilySelectionAction(): boolean;
  protected abstract _handleVisualNodeDragEnd(
    draggedNodeId: string,
    didMove: boolean,
    targetSubgraphId: string,
    cancelled: boolean,
    duplicate: boolean,
  ): void;
  protected abstract _previewVisualNodeReparent(
    nodeId: string,
    targetSubgraphId: string,
  ): void;
  protected abstract _hasActiveInlineShapeTextEditor(): boolean;
  protected abstract _hydrateVisualSelectionFromScopedGfxSelection(): boolean;
  protected abstract _hydrateVisualSelectionFromGfxIds(
    elementIds: readonly string[],
    requestHostUpdate?: boolean,
  ): boolean;
  protected abstract _insertPendingVisualNode(
    point: { x: number; y: number },
    shape: MermaidVisualNodeShape,
  ): string;
  protected abstract _isInEdgelessMode(): boolean;
  protected abstract _moveVisualNodeByDrag(
    nodeId: string,
    dx: number,
    dy: number,
  ): void;
  protected abstract _moveSelectedVisualNode(dx: number, dy: number): void;
  protected abstract _duplicateSelectedVisualNodes(
    offset?: Readonly<{ x: number; y: number }>,
  ): boolean;
  protected abstract _pauseProjectionOwnerSourceSync(): void;
  protected abstract _syncOwnerSourceNow(): boolean;
  protected abstract _previewVisualSubgraphReparent(
    subgraphId: string,
    targetSubgraphId: string,
  ): void;
  protected abstract _reparentVisualSubgraph(
    subgraphId: string,
    parentId: string,
    coalesceKey: string,
  ): void;
  protected abstract _reconcileProjectionOwnerFromSourceAfterHistory(): void;
  protected abstract _refreshScopedGfxRenderer(): void;
  protected abstract _scheduleProjectionOwnerSourceSync(): void;
  protected abstract _scheduleProjectionOwnerSourceSyncIfDrifted(): void;
  protected abstract _scheduleRender(): void;
  protected abstract _selectVisualEdge(edgeId: string): void;
  protected abstract _selectVisualNode(
    nodeId: string,
    additive?: boolean,
  ): boolean;
  protected abstract _selectVisualSubgraph(subgraphId: string): void;
  protected abstract _selectAllPageVisualNodes(): void;
  protected abstract _setVisualViewportHeight(height: number): void;
  protected abstract _startInlineEdgeTextEdit(
    event: MouseEvent | null,
    edgeId: string,
    point: { x: number; y: number },
  ): void;
  protected abstract _startInlineNodeTextEdit(
    event: MouseEvent,
    nodeId: string,
    model?: unknown,
  ): void;
  protected abstract _startInlineSubgraphTextEdit(
    event: MouseEvent | null,
    subgraphId: string,
  ): void;
  protected abstract _stopTransientPointerInteractions(): void;
  protected abstract _syncKnownProjectionOwnerDriftBeforeEnsure(): unknown;
  protected abstract _projectVisualSelectionToScopedGfx(): void;
  protected abstract _restoreVisualObjectFocus(): void;

  protected _renderState: MermaidRenderState = "empty";
  protected _pageSelectionState = createMermaidPageSelectionState();
  protected _pageSelectionEnabled = false;
  protected _pageViewportState = createMermaidPageViewportState();
  protected _embeddedGfxActionsSafeInset = 0;

  protected _setEmbeddedGfxActionsSafeInset(height: number) {
    const next = Number.isFinite(height) ? Math.max(0, Math.ceil(height)) : 0;
    const insetChanged = next !== this._embeddedGfxActionsSafeInset;
    this._embeddedGfxActionsSafeInset = next;
    // The inner Surface can be recreated by the React projection after the
    // inset first changes. Its initial client rect may still precede the outer
    // Note transform, so an equal follow-up measurement must refresh that new
    // controller before fitting. The inset remains the only persisted input;
    // controller geometry decides whether an equal report needs work.
    const clientRectChanged = this._gfxViewportBridge.refreshClientRect();
    if (this._isInEdgelessMode() && (insetChanged || clientRectChanged)) {
      this._fitScopedGfxViewport();
    }
    if (insetChanged) this.requestUpdate();
  }

  protected _transitionPageSelection(
    transition: MermaidPageSelectionTransition,
  ) {
    const next = transitionMermaidPageSelectionState(
      this._pageSelectionState,
      transition,
    );
    if (next === this._pageSelectionState) return false;
    // Page selection is transient UI state. Its render transition must never
    // consume an older Surface drift key as a Mermaid source edit.
    this._pauseProjectionOwnerSourceSync();
    this._acceptProjectionOwnerSourceSyncKey();
    this._pageSelectionState = next;
    this.requestUpdate();
    return true;
  }

  protected _cancelPageSelectionMode() {
    return this._handlePageSelectionToolChange("pointer");
  }

  protected readonly _handlePageSelectionToolChange = (
    tool: MermaidPageSelectionTool,
  ) => {
    this._pendingVisualInsertShape = null;
    this._pendingVisualNodePlacement = null;
    this._stopTransientPointerInteractions();
    const changed = this._transitionPageSelection({ tool, type: "tool" });
    if (changed) {
      void this.updateComplete.then(() =>
        this._projectVisualSelectionToScopedGfx(),
      );
    }
    return changed;
  };

  protected _getPageSelectionProjection() {
    return this._pageSelectionEnabled
      ? {
          onToolChange: this._handlePageSelectionToolChange,
          state: this._pageSelectionState,
        }
      : null;
  }

  protected _createVisualSelectionItem(
    kind: MermaidPageSelectionItem["kind"],
    editKey: string,
  ): MermaidPageSelectionItem | null {
    if (!editKey) return null;
    const visualModel = this._getMermaidVisualModelForEditing();
    const isKnownEditKey =
      kind === "node"
        ? visualModel?.nodes.some((node) => node.id === editKey)
        : kind === "edge"
          ? visualModel?.edges.some((edge) => edge.id === editKey)
          : visualModel?.subgraphs?.some((subgraph) => subgraph.id === editKey);
    if (!isKnownEditKey) return null;
    const model =
      kind === "node"
        ? this._getVisualNodeGfxModel(editKey)
        : kind === "edge"
          ? this._getVisualEdgeGfxModel(editKey)
          : this._getVisualSubgraphGfxModel(editKey);
    if (!model || !("id" in model)) return null;
    return { editKey, gfxElementId: String(model.id), kind };
  }

  protected _visualSelectionItems(kind?: MermaidPageSelectionItem["kind"]) {
    return kind
      ? this._visualSelection.itemsOfKind(kind)
      : this._visualSelection.items;
  }

  protected _visualSelectionKeys(kind: MermaidPageSelectionItem["kind"]) {
    return this._visualSelectionItems(kind).map((item) => item.editKey);
  }

  protected _visualSelectionAnchorKey(kind: MermaidPageSelectionItem["kind"]) {
    const anchor = this._visualSelection.anchor;
    return anchor?.kind === kind ? anchor.editKey : "";
  }

  protected _queueVisualSelectionForProjection(
    items: readonly Pick<MermaidPageSelectionItem, "editKey" | "kind">[],
    options?: { readonly focus?: boolean },
  ) {
    this._pendingVisualSelectionProjection = {
      items: items.map((item) => ({ ...item })),
      focus: options?.focus,
    };
  }

  protected _clearPendingVisualSelectionProjection() {
    this._pendingVisualSelectionProjection = null;
  }

  protected _replaceVisualSelection(
    kind: MermaidPageSelectionItem["kind"],
    editKeys: readonly string[],
  ) {
    this._visualSelection.apply(
      "replace",
      editKeys.flatMap((editKey) => {
        const item = this._createVisualSelectionItem(kind, editKey);
        return item ? [item] : [];
      }),
    );
  }

  protected _remapVisualSelection() {
    // Reconnect can change a Source-derived alias pair without changing the
    // record's opaque editor ID. Validate against the bound owner readback,
    // not a fresh parse that has no child identities to reconcile that ID.
    const sourceModel =
      this._getMermaidVisualModelForEditing() ??
      getMermaidVisualModel(this.model);
    const isKnownEditKey = (
      item: Pick<MermaidPageSelectionItem, "kind" | "editKey">,
    ) =>
      Boolean(
        item.kind === "node"
          ? sourceModel?.nodes.some((node) => node.id === item.editKey)
          : item.kind === "edge"
            ? sourceModel?.edges.some((edge) => edge.id === item.editKey)
            : sourceModel?.subgraphs?.some(
                (subgraph) => subgraph.id === item.editKey,
              ),
      );
    if (sourceModel)
      pruneMermaidSelectionBookmark(
        this.store.id,
        this.model.id,
        this.model.props.diagramType,
        isKnownEditKey,
      );
    this._visualSelection.remap((item) => {
      return isKnownEditKey(item)
        ? (this._createVisualSelectionItem(item.kind, item.editKey)
            ?.gfxElementId ?? null)
        : null;
    });
    this.requestUpdate();
  }

  protected _transitionPageViewport(transition: MermaidPageViewportTransition) {
    const next = transitionMermaidPageViewportState(
      this._pageViewportState,
      transition,
    );
    if (next === this._pageViewportState) return false;
    this._pageViewportState = next;
    this.requestUpdate();
    return true;
  }
  protected _changePageZoom(
    intent: MermaidPageZoomChangeIntent,
    mode: MermaidPageViewportMode = "visual",
  ) {
    const changed = this._transitionPageViewport({
      intent,
      mode,
      type: "zoom",
    });
    if (!changed || this._mode === "source") return changed;
    this._scopedGfxViewportUserPositioned = intent.zoom !== "auto";
    const scale =
      intent.zoom === "auto"
        ? this._gfxViewportBridge.applyPageZoom(intent.zoom, intent.anchor)
        : intent.zoom / 100;
    if (scale) {
      this._transitionPageViewport({
        mode,
        scale,
        type: "resolved-scale",
      });
    }
    return changed;
  }
  protected _getPageViewportProjection(
    mode: MermaidPageViewportMode,
  ): MermaidPageViewportProjection {
    const currentState = () => this._pageViewportState;
    return {
      mode,
      onAvailabilityChange: (available) =>
        this._transitionPageViewport({ available, mode, type: "availability" }),
      onPositionChange: (position) =>
        this._handlePageViewportPositionChange(mode, position),
      onResolvedScaleChange: (scale) =>
        this._transitionPageViewport({ mode, scale, type: "resolved-scale" }),
      onZoomChange: (intent) => this._changePageZoom(intent, mode),
      resolveCenterPosition: () =>
        this._gfxViewportBridge.resolvePageCenterPosition(
          this._pageViewportState.resolvedScales[mode],
        ),
      navigationRevision: this._gfxViewportBridge.pageNavigationRevision,
      resolveNavigationGeometry: (scale) =>
        this._gfxViewportBridge.resolvePageNavigationGeometry(scale),
      // Native scroll/camera callbacks can publish a newer offset before the
      // queued React projection commits. Effects must read the current owner
      // state rather than replaying the captured render's older camera.
      get state() {
        return currentState();
      },
    };
  }
  private _handlePageViewportPositionChange(
    mode: MermaidPageViewportMode,
    position: Parameters<MermaidPageViewportProjection["onPositionChange"]>[0],
  ) {
    this._transitionPageViewport({
      mode,
      position,
      type: "position",
    });
    // The projection belongs to the currently mounted Page viewport. `view`
    // is intentionally not a MermaidViewMode, so comparing it with `_mode`
    // suppresses the display camera while its Mantine thumb still moves.
    this._gfxViewportBridge.applyPageScroll(
      position,
      this._pageViewportState.resolvedScales[mode],
    );
  }
  protected _centerPageViewport(mode: MermaidPageViewportMode) {
    return this._transitionPageViewport({ mode, type: "center" });
  }
  protected _renderErrorLine: number | null = null;
  protected _renderErrorMessage: string | null = null;
  protected _renderTimer: ReturnType<typeof setTimeout> | null = null;
  protected readonly _ownerSourceSync = new MermaidOwnerSourceSyncController();
  // Keep BlockComponent-owned state behind callbacks: Lit field initializers run
  // before model/std accessors are safe to dereference in extracted controllers.
  protected readonly _ownerGfx = new MermaidOwnerGfxBridge({
    acceptProjectionOwnerSourceSyncKey: () =>
      this._acceptProjectionOwnerSourceSyncKey(),
    getMode: () => this._mode,
    getModel: () => this.model,
    getStd: () => this.std,
    getStore: () => this.store,
    hasActiveInlineTextEditor: () => this._hasActiveInlineShapeTextEditor(),
    hasActivePointerSession: () => this._visualNodePointerSessionActive,
    isInEdgelessMode: () => this._isInEdgelessMode(),
    scheduleProjectionOwnerSourceSyncIfDrifted: () =>
      this._scheduleProjectionOwnerSourceSyncIfDrifted(),
  });
  protected readonly _inlineShapeTextEditor =
    new MermaidInlineShapeTextEditorController({
      getViewportElement: () => this._getScopedGfxViewport(),
      scheduleProjectionOwnerSourceSync: () =>
        this._scheduleProjectionOwnerSourceSync(),
      toViewPoint: (x, y) => this._gfxViewportBridge.toViewPoint(x, y),
    });
  protected readonly _inlineConnectorLabelEditor =
    new MermaidInlineConnectorLabelEditorController({
      getViewportElement: () => this._getScopedGfxViewport(),
      scheduleProjectionOwnerSourceSync: () =>
        this._scheduleProjectionOwnerSourceSync(),
      setConnectorLabelEditActive: (active) => {
        this._isInlineConnectorLabelEditing = active;
      },
    });
  protected readonly _gfxViewportBridge = new MermaidGfxViewportBridge({
    getElement: () => this,
    getModel: () => this.model,
    getRenderRoot: () => this.renderRoot,
    getViewportSafeInsetBottom: () =>
      this._isInEdgelessMode() ? this._embeddedGfxActionsSafeInset : 0,
  });
  protected readonly _visualSelection = new MermaidPageSelectionController(
    (items) => {
      const elementIds = items.map((item) => item.gfxElementId);
      // Native selection is a transport projection of the semantic owner.
      // Record the projected key before GFX emits its synchronous update so
      // the echo cannot hydrate the controller as a second transition.
      this._lastProjectionOwnerSelectionKey = elementIds.join(",");
      this._getScopedGfxController()?.selection?.set?.({
        editing: false,
        elements: elementIds,
      });
    },
    (items) =>
      rememberMermaidSelection(
        this.store.id,
        this.model.id,
        this.model.props.diagramType,
        items,
      ),
  );
  protected _restoredSessionSelection = false;
  protected readonly _gfxViewportInteraction =
    new MermaidGfxViewportInteractionController({
      activateScopedEditor: () => this._activateEmbeddedGfxEditor(),
      consumeNodeDragStart: (event) => {
        const claimed = Boolean(this._familyNodePointerDown?.(event));
        if (claimed) this._markScopedGfxViewportUserPositioned();
        return claimed;
      },
      consumeObjectIntent: (event, phase) =>
        this._consumeVisualObjectPointerIntent(event, phase),
      canConsumeViewportEvent: () => this._canConsumeScopedGfxEvent(),
      captureViewport: () => this._captureScopedGfxViewport(),
      clearVisualSelection: () => this._clearVisualSelection(),
      findVisualEdgeByModelPoint: (x, y) =>
        this._findVisualEdgeByModelPoint(x, y),
      findVisualNodeByClientPoint: (clientX, clientY) =>
        this._findVisualNodeByClientPoint(clientX, clientY),
      findVisualNodeModelByClientPoint: (clientX, clientY) =>
        this._findVisualNodeModelByClientPoint(clientX, clientY),
      findVisualSubgraphByModelPoint: (x, y) =>
        this._findVisualSubgraphByModelPoint(x, y),
      findVisualSubgraphHeaderByModelPoint: (x, y) =>
        this._findVisualSubgraphHeaderByModelPoint(x, y),
      getExplicitVisualNodeOrder: () => this._visualSelectionKeys("node"),
      getPendingVisualInsertShape: () => this._pendingVisualInsertShape,
      getPageSelectionTool: () => this._pageSelectionState.tool,
      getScopedGfxViewport: () => this._getScopedGfxViewport(),
      getScopedModelPointFromClient: (clientX, clientY) =>
        this._getScopedModelPointFromClient(clientX, clientY),
      getScopedModelDeltaFromClient: (dx, dy) =>
        this._getScopedModelDeltaFromClient(dx, dy),
      getSelectedVisualNodeId: () => this._visualSelectionAnchorKey("node"),
      getSelectedVisualEdgeId: () => this._visualSelectionAnchorKey("edge"),
      getSelectedVisualNodeOrder: () => this._visualSelectionKeys("node"),
      insertPendingVisualNode: (point, shape) =>
        this._insertPendingVisualNode(point, shape),
      isConnectingVisualNodes: () => this._gfxSession.isConnectingVisualNodes,
      isEditableEventTarget: (event) =>
        Boolean(this._getEditableEventTarget(event)),
      isReadonly: () => this.store.readonly,
      moveVisualNode: (nodeId, dx, dy) =>
        this._moveVisualNodeByDrag(nodeId, dx, dy),
      onVisualNodeDragEnd: (
        nodeId,
        didMove,
        targetSubgraphId,
        cancelled,
        duplicate,
      ) =>
        this._handleVisualNodeDragEnd(
          nodeId,
          didMove,
          targetSubgraphId,
          cancelled,
          duplicate,
        ),
      panViewportNearClientPoint: (clientX, clientY, maxViewDelta) =>
        this._panScopedGfxViewportNearClientPoint(
          clientX,
          clientY,
          maxViewDelta,
        ),
      previewVisualNodeReparent: (nodeId, targetSubgraphId) =>
        this._previewVisualNodeReparent(nodeId, targetSubgraphId),
      requestUpdate: () => this.requestUpdate(),
      restoreViewport: (snapshot) => this._restoreScopedGfxViewport(snapshot),
      selectVisualEdge: (edgeId) => this._selectVisualEdge(edgeId),
      selectVisualNode: (nodeId, additive) => {
        if (
          this._gfxSession.handleProjectionOwnerNodeSelection(
            nodeId,
            this._visualSelectionAnchorKey("node"),
          )
        ) {
          return true;
        }
        this._selectVisualNode(nodeId, additive);
        return false;
      },
      selectVisualSubgraph: (subgraphId) =>
        this._selectVisualSubgraph(subgraphId),
      setVisualNodePointerSessionActive: (active) =>
        this._setVisualNodePointerSessionActive(active),
      setSelectedVisualNodeOrder: (nodeOrder) => {
        this._replaceVisualSelection("node", nodeOrder);
      },
      setVisualInspectorSuppressed: (suppressed) => {
        this._visualInspectorSuppressed = suppressed;
      },
      setVisualContextMenu: (menu) => {
        this._visualContextMenu = menu;
      },
      startInlineEdgeTextEdit: (event, edgeId, point) =>
        this._startInlineEdgeTextEdit(event, edgeId, point),
      startInlineNodeTextEdit: (event, nodeId, model) =>
        this._startInlineNodeTextEdit(event, nodeId, model),
      startInlineSubgraphTextEdit: (event, subgraphId) =>
        this._startInlineSubgraphTextEdit(event, subgraphId),
    });
  protected readonly _gfxSession = new MermaidGfxSessionController({
    proposeConnection: (connection) =>
      Boolean(
        getMermaidGfxFamilyHooks(this._getMermaidVisualModelForEditing())
          ?.connectionsViaFamilyControls &&
        this._consumeVisualObjectIntent({
          kind: connection.edgeId ? "edge" : "node",
          id: connection.edgeId ?? connection.sourceNodeId,
          connection,
        }),
      ),
    announceDiagnostic: (message) => {
      this._pageSelectionAnnouncement = message;
      this.requestUpdate();
    },
    applyGfxMutation: (run, options) => this._applyGfxMutation(run, options),
    applyVisualSelectionPatch: (patch) =>
      this._applyVisualSelectionPatch(patch),
    findVisualNodeByClientPoint: (clientX, clientY) =>
      this._gfxViewportBridge.findConnectionTargetByClientPoint(
        clientX,
        clientY,
      ),
    getMermaidVisualModelForEditing: () =>
      this._getMermaidVisualModelForEditing(),
    getModel: () => this.model,
    getViewportIdentity: () =>
      this._gfxViewportBridge.getController()?.viewport ??
      this._getScopedGfxViewport(),
    getPreviewElement: (id) =>
      this._gfxViewportBridge.getController()?.getElementById?.(id),
    getScopedModelPointFromClient: (clientX, clientY) =>
      this._getScopedModelPointFromClient(clientX, clientY),
    getScopedViewPointFromClient: (clientX, clientY) =>
      this._getScopedViewPointFromClient(clientX, clientY),
    getSelectedVisualEdgeId: () => this._visualSelectionAnchorKey("edge"),
    getSelectedVisualEdgeHandles: () => this._getSelectedVisualEdgeHandles(),
    getSelectedVisualNodeHandles: () => this._getSelectedVisualNodeHandles(),
    getSelectedVisualNodeId: () => this._visualSelectionAnchorKey("node"),
    getSelectedVisualSubgraphId: () =>
      this._visualSelectionAnchorKey("subgraph"),
    getStd: () => this.std,
    getViewportResizeStep: () => MERMAID_SCOPED_GFX_PAGE_VIEWPORT_RESIZE_STEP,
    refreshRenderer: () => this._refreshScopedGfxRenderer(),
    getVisualNodeConnectionHandles: (nodeId) =>
      this._getVisualNodeConnectionHandles(nodeId),
    getVisualNodeGfxModel: (nodeId) => this._getVisualNodeGfxModel(nodeId),
    getVisualSubgraphGfxModel: (subgraphId) =>
      this._getVisualSubgraphGfxModel(subgraphId),
    isReadonly: () => this.store.readonly,
    commitProjectionOwnerGeometry: () => {
      const synced = this._syncOwnerSourceNow();
      // Pointer release closes one history gesture. Reusing the shape's key
      // on a later drag must not merge two independently accepted movements.
      const entry = this._visualUndoStack.at(-1);
      if (entry) entry.coalesceKey = undefined;
      return synced;
    },
    previewVisualSubgraphReparent: (subgraphId, targetSubgraphId) =>
      this._previewVisualSubgraphReparent(subgraphId, targetSubgraphId),
    reparentVisualSubgraph: (subgraphId, parentId, coalesceKey) =>
      this._reparentVisualSubgraph(subgraphId, parentId, coalesceKey),
    requestUpdate: () => this.requestUpdate(),
    scheduleRender: () => this._scheduleRender(),
    selectVisualEdge: (edgeId) => this._selectVisualEdge(edgeId),
    selectVisualSubgraph: (subgraphId) =>
      this._selectVisualSubgraph(subgraphId),
    setVisualViewportHeight: (height) => this._setVisualViewportHeight(height),
    suppressNextViewportClickSelection: () =>
      this._gfxViewportInteraction.suppressNextClickSelection(),
  });
  protected _scopedGfxViewportElement: Element | null = null;
  protected _scopedGfxNestedListenerElements: EventTarget[] = [];
  protected _scopedGfxNestedListenerObserver: MutationObserver | null = null;
  protected _isInlineConnectorLabelEditing = false;
  protected _lastProjectionOwnerSelectionKey = "";
  protected _lastScopedGfxFitKey = "";
  protected _scopedGfxFitRequestVersion = 0;
  protected _scopedGfxViewportUserPositioned = false;
  protected _preserveScopedGfxViewportForNodeId = "";
  protected _preservedScopedGfxViewport: MermaidScopedGfxViewportSnapshot | null =
    null;
  protected _pendingVisualSelectionProjection: {
    readonly focus?: boolean;
    readonly items: ReadonlyArray<
      Pick<MermaidPageSelectionItem, "editKey" | "kind">
    >;
  } | null = null;
  protected _pendingVisualInsertShape: MermaidVisualNodeShape | null = null;
  protected _showAllVisualShapes = false;
  protected _mode: MermaidViewMode = "visual";
  protected _keyboardFocusedVisualItem: Pick<
    MermaidPageSelectionItem,
    "editKey" | "kind"
  > | null = null;
  protected _pageSelectionAnnouncement = "";
  protected _visualInspectorSuppressed = false;
  protected _visualAutoViewportHeight: number | null = null;
  protected _visualNodeDragModel: MermaidVisualModel | null = null;
  protected _visualNodePointerSessionActive = false;
  protected _visualContextMenu: { left: number; top: number } | null = null;
  // Alignment guides have no native GFX element identity. Keep only the
  // currently invoked guide so two legal alignments over the same members can
  // still address the correct existing command; node selection remains owned
  // exclusively by the central visual selection controller.
  protected _visualAlignmentGuideId = "";
  protected _visualSubgraphDropPreview: {
    height: number;
    id: string;
    left: number;
    top: number;
    width: number;
  } | null = null;
  protected _svg = "";
  protected _lastValidSvg = "";
  protected get _visualRedoStack(): MermaidVisualHistoryEntry[] {
    return getMermaidVisualHistoryStacks(this.model).redoStack;
  }

  protected get _visualUndoStack(): MermaidVisualHistoryEntry[] {
    return getMermaidVisualHistoryStacks(this.model).undoStack;
  }

  protected readonly _handleDocumentKeydown = (event: KeyboardEvent) => {
    const capturePhase = event.eventPhase === Event.CAPTURING_PHASE;
    const inEdgeless = this._isInEdgelessMode();
    const activeElement = document.activeElement;
    const hasBlockFocus =
      activeElement === this ||
      (activeElement instanceof Node && this.contains(activeElement));
    const embeddedKeyboardOwner = Boolean(
      this._getParentEdgelessNoteId() &&
      this._canConsumeScopedGfxEvent() &&
      (this._isActiveEmbeddedGfxEditor() ||
        MermaidHostState.activeKeyboardBlock === this ||
        hasBlockFocus),
    );
    // Page keeps its established early host handling. Embedded Edgeless owns
    // every key once at Window capture because a Facade action may return
    // focus to a portal trigger or Body outside this custom element. A central
    // history replay may clear BlockSelection, so actual host focus must remain
    // sufficient to reclaim Redo before the outer editor consumes it. Native
    // Edgeless Mermaid remains on its local host boundary, except Escape.
    const ownsEdgelessCapture =
      inEdgeless && (event.key === "Escape" || embeddedKeyboardOwner);
    if (inEdgeless ? capturePhase !== ownsEdgelessCapture : !capturePhase)
      return;
    if (
      event.defaultPrevented ||
      this.store.readonly ||
      !this._canConsumeScopedGfxEvent()
    )
      return;
    if (
      MermaidHostState.activeKeyboardBlock !== this &&
      !this.selected$.value &&
      !hasBlockFocus
    )
      return;
    this._handleBlockKeydown(event);
  };
}
