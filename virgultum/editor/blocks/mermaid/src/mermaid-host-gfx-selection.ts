import { typeOwnedMermaidGeometrySelection } from "./families/runtime/gfx-owner-hooks.js";
import {
  readMermaidSelectionBookmark,
  rememberMermaidSelection,
} from "./families/runtime/session-selection.js";
import type { SurfaceBlockModel } from "@virgultum/block-surface";
import { Bound } from "@virgultum/global/gfx";
import { ConnectorElementModel, ShapeElementModel } from "@virgultum/model";
import { BlockComponent } from "@virgultum/std";

import {
  applyMermaidVisualModelCommand,
  getMermaidVisualModel,
} from "./commands.js";

import {
  addMermaidGfxEdgeCommand,
  addMermaidGfxNodeCommand,
  applyMermaidGfxNodeCommand,
} from "./families/runtime/gfx-commands.js";
import { shouldReconcileTypeOwnedMermaidNodeDragEnd } from "./families/runtime/gfx-owner-hooks.js";
import {
  createMermaidGfxVisualNode,
  reparentTypeOwnedMermaidGfxNodes,
  reparentTypeOwnedMermaidGfxSubgraph,
} from "./families/runtime/gfx-graph-operations.js";
import {
  type MermaidVisualNodeShape,
  resolveMermaidGfxContextMenuLabel,
} from "./families/runtime/gfx-host-contract.js";
import {
  resolveTypeOwnedMermaidNodeInlineRename,
  resolveTypeOwnedMermaidNodeInlineValue,
  resolveTypeOwnedMermaidSubgraphInlineRename,
  resolveTypeOwnedMermaidSubgraphInlineValue,
} from "./families/runtime/gfx-inline-hooks.js";
import { getMermaidFamilyRuntime } from "./families/runtime/registry.js";
import { getMermaidGfxFamilyHooks } from "./families/runtime/gfx-family-hooks-registry.js";
import type { MermaidPageSelectionItem } from "./mermaid-page-selection-controller.js";

import { resolveMermaidGfxProjection } from "./presentation/gfx-projection-owner.js";

import {
  resolveMermaidGfxContextConnection,
  resolveMermaidGfxContextConnectionResult,
} from "./mermaid-gfx-context-menu.js";
import {
  accumulateMermaidGfxNodeDrag,
  releaseMermaidGfxPreviewProperty,
  resolveMermaidGfxNodeDragEndSubgraph,
} from "./mermaid-gfx-drag.js";

import { resolveMermaidGfxPendingNodeInsert } from "./mermaid-gfx-insert.js";
import { readMermaidGfxMeta } from "./mermaid-gfx-metadata.js";
import { mermaidMessages } from "./i18n.js";
import {
  getMermaidGfxSelectedElementIds,
  getMermaidGfxSelectionIdentity,
} from "./mermaid-gfx-selection.js";
import {
  clearMermaidGfxSelectionPatch,
  connectMermaidGfxSelectionPatch,
  insertMermaidGfxNodeSelectionPatch,
  selectMermaidGfxEdgePatch,
  selectMermaidGfxNodesPatch,
  selectMermaidGfxSubgraphPatch,
} from "./mermaid-gfx-selection-state.js";

import { MermaidHostGfxViewport } from "./mermaid-host-gfx-viewport.js";
import { getMermaidBlockSource } from "./utils.js";

export abstract class MermaidHostGfxSelection extends MermaidHostGfxViewport {
  // Placement commits the default node before the replacement projection can
  // mount its inline editor. Keep only that node identity until the editor
  // closes so its initial label commit joins the same visual-history entry.
  private _pendingInsertedVisualNodeLabelCommitId = "";
  private _transientVisualNodeDrag: {
    connectors: Array<{
      element: ConnectorElementModel;
      initialLabelXYWH: ConnectorElementModel["labelXYWH"];
      initialPath: ConnectorElementModel["path"];
      initialXywh: ConnectorElementModel["xywh"];
    }>;
    elements: Array<{
      element: ShapeElementModel;
      initialXywh: ShapeElementModel["xywh"];
    }>;
    nodeIds: readonly string[];
    startModel: NonNullable<ReturnType<typeof getMermaidVisualModel>>;
    source: string;
    viewportIdentity: object | null;
    subgraphs: Array<{
      element: ShapeElementModel;
      initialXywh: ShapeElementModel["xywh"];
    }>;
  } | null = null;

  protected _selectVisualSubgraph(subgraphId: string) {
    this._visualInspectorSuppressed = false;
    this._applyVisualSelectionPatch(selectMermaidGfxSubgraphPatch(subgraphId));
    this.requestUpdate();
    this._scheduleScopedGfxSelectionVisibility();
  }

  protected _clearVisualSelection() {
    this._visualInspectorSuppressed = false;
    this._applyVisualSelectionPatch(clearMermaidGfxSelectionPatch());
    this.requestUpdate();
  }

  protected _clearPageVisualSelectionFromKeyboard() {
    this._clearVisualSelection();
    this._pageSelectionAnnouncement = mermaidMessages.pageSelectionAnnouncement(
      mermaidMessages.pageSelectionAllNodes(),
      0,
    );
    this.requestUpdate();
  }

  protected _hydrateVisualSelectionFromScopedGfxSelection() {
    const selection = this._getScopedGfxController()?.selection as
      | {
          selectedElements?: ReadonlyArray<{ id?: string }>;
          selectedIds?: readonly string[];
        }
      | undefined;
    const selectedIds = getMermaidGfxSelectedElementIds(selection);
    return this._hydrateVisualSelectionFromGfxIds(selectedIds);
  }

  protected _hydrateVisualSelectionFromGfxIds(
    selectedIds: readonly string[],
    requestHostUpdate = true,
  ) {
    if (selectedIds.length === 0) {
      this._visualSelection.hydrate([]);
      if (requestHostUpdate) this.requestUpdate();
      return false;
    }

    const items = this._resolveVisualSelectionItemsFromGfxIds(selectedIds);
    if (!items) return false;
    this._visualSelection.hydrate(items);
    if (requestHostUpdate) this.requestUpdate();
    return items.length > 0;
  }

  protected _resolveVisualSelectionItemsFromGfxIds(
    selectedIds: readonly string[],
  ): MermaidPageSelectionItem[] | null {
    const resolution = resolveMermaidGfxProjection(this.model);
    if (!resolution) return null;
    return selectedIds.flatMap<MermaidPageSelectionItem>((id) => {
      const model = resolution.getElementById(id) as
        | {
            id?: string;
            type?: string;
          }
        | null
        | undefined;
      const identity = getMermaidGfxSelectionIdentity(model);
      if (identity.isSubgraphShape && identity.subgraphId) {
        return [
          {
            editKey: identity.subgraphId,
            gfxElementId: id,
            kind: "subgraph" as const,
          },
        ];
      }
      if (identity.isNodeShape) {
        return [
          {
            editKey: identity.nodeId,
            gfxElementId: id,
            kind: "node" as const,
          },
        ];
      }
      if (identity.isEdgeConnector) {
        return [
          {
            editKey: identity.edgeId,
            gfxElementId: id,
            kind: "edge" as const,
          },
        ];
      }
      return [];
    });
  }

  protected _applyVisualSelectionGfxOperation(
    operation: "add" | "replace" | "subtract" | "toggle",
    baseIds: readonly string[],
    candidateIds: readonly string[],
  ) {
    this._visualAlignmentGuideId = "";
    const base = this._resolveVisualSelectionItemsFromGfxIds(baseIds);
    const candidates =
      this._resolveVisualSelectionItemsFromGfxIds(candidateIds);
    if (!base || !candidates) return;
    this._visualSelection.applyAgainst(base, operation, candidates);
    this._visualContextMenu = null;
    this.requestUpdate();
  }

  protected _getSelectedVisualNodeGfxModels() {
    return this._visualSelectionKeys("node")
      .map((nodeId) => this._getVisualNodeGfxModel(nodeId))
      .filter((model): model is { id: string; xywh?: string } =>
        Boolean(model && "id" in model),
      );
  }

  protected _projectVisualSelectionToScopedGfx() {
    this._visualSelection.project();
  }

  protected _selectAllPageVisualNodes() {
    const visualModel = this._getMermaidVisualModelForEditing();
    if (!visualModel) return;
    const tools = getMermaidFamilyRuntime(
      visualModel.diagramType,
    )?.pageSelectionTools;
    if (!tools) return;
    const selectAllKinds = new Set(tools.selectAllKinds);
    const nodeIds = tools
      .resolveItems(visualModel)
      .filter(
        (item) =>
          item.selectAllSelectable !== false && selectAllKinds.has(item.kind),
      )
      .map((item) => item.editKey);
    this._applyVisualSelectionPatch(selectMermaidGfxNodesPatch(nodeIds));
    this._pageSelectionAnnouncement = mermaidMessages.pageSelectionAnnouncement(
      mermaidMessages.pageSelectionAllNodes(),
      nodeIds.length,
    );
    this.requestUpdate();
  }

  protected _handlePageVisualObjectFocus(
    item: Pick<MermaidPageSelectionItem, "editKey" | "kind">,
  ) {
    if (
      this._keyboardFocusedVisualItem?.editKey === item.editKey &&
      this._keyboardFocusedVisualItem.kind === item.kind
    )
      return;
    this._keyboardFocusedVisualItem = { ...item };
    this.requestUpdate();
  }

  protected _restoreVisualObjectFocus() {
    // A history replay can reuse the mounted scope when child IDs are stable;
    // its mount-ready callback then has already run before the focus handoff.
    if (
      this.isConnected &&
      this._pendingVisualSelectionProjection?.focus &&
      this._gfxViewportBridge.getController()
    )
      this._reconcileVisualSelectionProjection();
    const item = this._keyboardFocusedVisualItem;
    if (
      !this.isConnected ||
      !item ||
      (!this._isActiveEmbeddedGfxEditor() &&
        !(
          !this._isInEdgelessMode() &&
          this.selected$.value &&
          this._visualSelection.anchor?.editKey === item.editKey &&
          this._visualSelection.anchor.kind === item.kind
        )) ||
      document.activeElement !== document.body
    )
      return;
    // A projection remount may detach and reinsert a still-connected proxy.
    // Restore its semantic identity only when focus was lost to Body; another
    // control or popup remains authoritative.
    Array.from(
      this.renderRoot.querySelectorAll<HTMLElement>(
        ".myoxus-mermaid-gfx-object-focus-proxy",
      ),
    )
      .find(
        (proxy) =>
          proxy.dataset.mermaidEditKey === item.editKey &&
          proxy.dataset.objectKind === item.kind,
      )
      ?.focus({ preventScroll: true });
  }

  protected _handlePageVisualWorkareaFocus(event: FocusEvent) {
    this._activateEmbeddedGfxEditor();
    if (!this._isActiveEmbeddedGfxEditor()) return;
    this._claimKeyboardOwner();
    if (
      event.target instanceof Element &&
      event.target.matches(".myoxus-mermaid-gfx-object-focus-proxy")
    ) {
      return;
    }
    if (!this._keyboardFocusedVisualItem) return;
    this._keyboardFocusedVisualItem = null;
    this.requestUpdate();
  }

  protected _handlePageVisualWorkareaFocusOut(event: FocusEvent) {
    // A temporarily detached workarea has no focus destination. The keyed
    // activation handoff retains that object; a real move to another control
    // still clears its keyboard outline below.
    if (event.relatedTarget === null) return;
    if (
      event.relatedTarget instanceof Element &&
      event.relatedTarget.matches(".myoxus-mermaid-gfx-object-focus-proxy")
    ) {
      return;
    }
    if (!this._keyboardFocusedVisualItem) return;
    this._keyboardFocusedVisualItem = null;
    this.requestUpdate();
  }

  protected async _handlePageVisualObjectKeydown(
    event: KeyboardEvent,
    item: Pick<MermaidPageSelectionItem, "editKey" | "kind">,
    mutationReadonly: boolean,
  ) {
    if (event.key !== " " && event.key !== "Enter") return;
    if (
      event.isComposing ||
      event.shiftKey ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    const visualModel = this._getMermaidVisualModelForEditing();
    const label =
      item.kind === "node"
        ? visualModel?.nodes.find((node) => node.id === item.editKey)?.label
        : item.kind === "edge"
          ? visualModel?.edges.find((edge) => edge.id === item.editKey)?.label
          : visualModel?.subgraphs?.find(
              (subgraph) => subgraph.id === item.editKey,
            )?.title;
    if (event.key === "Enter") {
      if (item.kind === "node") this._selectVisualNode(item.editKey);
      else if (item.kind === "edge") this._selectVisualEdge(item.editKey);
      else if (item.kind === "subgraph") {
        this._selectVisualSubgraph(item.editKey);
      }
      this._ensureScopedGfxSelectionVisible();
      this._pageSelectionAnnouncement =
        mermaidMessages.pageSelectionAnnouncement(label || item.editKey, 1);
      this.requestUpdate();
      if (mutationReadonly && this._isInEdgelessMode()) {
        this._activateEmbeddedGfxEditor();
        // The first Enter can focus an object in the passive Note projection.
        // Consume the editable scope installed by activation, not that old
        // render's readonly handler, before opening the same object intent.
        await this.updateComplete;
        mutationReadonly = !this._pageSelectionEnabled;
      }
      if (mutationReadonly || this._mode !== "visual") return;
      if (item.kind === "node") {
        const intent =
          visualModel &&
          getMermaidGfxFamilyHooks(visualModel)?.nodeKeyboardIntent?.(
            visualModel,
            item.editKey,
            "Enter",
          );
        if (intent && this._consumeVisualObjectIntent(intent)) return;
        this._startInlineNodeTextEdit(null, item.editKey);
      } else if (item.kind === "edge") {
        const edgeModel = this._getVisualEdgeGfxModel(item.editKey);
        const labelXYWH = edgeModel?.labelXYWH;
        const editBound = labelXYWH
          ? new Bound(...labelXYWH)
          : edgeModel?.xywh
            ? Bound.deserialize(edgeModel.xywh)
            : null;
        if (editBound) {
          this._startInlineEdgeTextEdit(null, item.editKey, {
            x: editBound.x + editBound.w / 2,
            y: editBound.y + editBound.h / 2,
          });
        }
      } else if (item.kind === "subgraph") {
        this._startInlineSubgraphTextEdit(null, item.editKey);
      }
      return;
    }
    const selectionItem = this._createVisualSelectionItem(
      item.kind,
      item.editKey,
    );
    if (!selectionItem) return;
    this._visualSelection.apply("toggle", [selectionItem]);
    this._pageSelectionAnnouncement = mermaidMessages.pageSelectionAnnouncement(
      label || item.editKey,
      this._visualSelection.items.length,
    );
    this.requestUpdate();
  }

  protected _selectedVisualNodeContextLabel(
    visualModel: NonNullable<ReturnType<typeof getMermaidVisualModel>>,
  ) {
    return resolveMermaidGfxContextMenuLabel({
      nodeOrder: this._visualSelectionKeys("node"),
      nodes: visualModel.nodes,
    });
  }

  protected _selectVisualNode(nodeId: string, additive = false) {
    this._pendingVisualInsertShape = null;
    const item = this._createVisualSelectionItem("node", nodeId);
    if (!item) return false;
    this._visualSelection.apply(additive ? "toggle" : "replace", [item]);
    this.requestUpdate();
    this._scheduleScopedGfxSelectionVisibility();
    return true;
  }

  protected _restoreSessionVisualSelection() {
    if (!this._restoredSessionSelection) {
      this._restoredSessionSelection = true;
      const bookmark = readMermaidSelectionBookmark(this.store.id);
      const kinds = getMermaidGfxFamilyHooks(
        this._getMermaidVisualModelForEditing(),
      )?.sessionSelectionKinds;
      if (
        !this._pendingVisualSelectionProjection &&
        bookmark?.ownerId === this.model.id &&
        kinds
      ) {
        const restored = bookmark.items.flatMap((item) =>
          kinds.includes(item.kind)
            ? (this._createVisualSelectionItem(item.kind, item.editKey) ?? [])
            : [],
        );
        if (restored.length === bookmark.items.length)
          this._visualSelection.apply("replace", restored);
        else
          rememberMermaidSelection(
            this.store.id,
            this.model.id,
            this.model.props.diagramType,
            [],
          );
      }
    }
  }

  /** Reconcile queued selection only after the scoped projection is ready. */
  protected _reconcileVisualSelectionProjection() {
    const insertedNodeId = this._preserveScopedGfxViewportForNodeId;
    const pending = this._pendingVisualSelectionProjection;
    if (pending) {
      const resolved = pending.items.flatMap((item) => {
        const selectionItem = this._createVisualSelectionItem(
          item.kind,
          item.editKey,
        );
        return selectionItem ? [selectionItem] : [];
      });
      if (resolved.length === pending.items.length) {
        this._visualSelection.apply("replace", resolved);
        if (pending.focus) {
          this.requestUpdate();
          // Invalid repair replaces the readonly workarea. Its new carrier can
          // receive focus only after the ready projection has been rendered.
          void this.updateComplete.then(() => {
            const key = resolved.at(-1)?.editKey;
            if (this._visualSelection.anchor?.editKey !== key) return;
            const carrier = Array.from(
              this.renderRoot.querySelectorAll<HTMLElement>(
                ".myoxus-mermaid-gfx-object-focus-proxy",
              ),
            ).find((element) => element.dataset.mermaidEditKey === key);
            const target =
              carrier ?? this._gfxViewportBridge.getViewportElement();
            this._ensureScopedGfxSelectionVisible();
            if (target instanceof HTMLElement)
              target.focus({ preventScroll: true });
            // Page history can replace this carrier once more after readiness.
            // Repair only focus lost to Body; deliberate control focus wins.
            requestAnimationFrame(() => this._restoreVisualObjectFocus());
          });
        }
        const createdSubgraph =
          pending.items.length === 1 && pending.items[0]?.kind === "subgraph"
            ? pending.items[0]
            : null;
        if (!createdSubgraph) this._pendingVisualSelectionProjection = null;
      } else {
        this._pendingVisualSelectionProjection = null;
        this._remapVisualSelection();
      }
    } else if (insertedNodeId) {
      const inserted = this._createVisualSelectionItem("node", insertedNodeId);
      if (inserted) this._visualSelection.apply("replace", [inserted]);
      else this._remapVisualSelection();
    } else {
      this._remapVisualSelection();
    }
    if (insertedNodeId) {
      this._gfxViewportBridge.restoreViewport(this._preservedScopedGfxViewport);
      this._lastScopedGfxFitKey = this._gfxViewportBridge.createFitKey();
    }
    this.requestUpdate();
  }

  protected _completePendingInsertedNodeProjection() {
    const insertedNodeId = this._preserveScopedGfxViewportForNodeId;
    if (!insertedNodeId) return false;
    this._gfxViewportBridge.restoreViewport(this._preservedScopedGfxViewport);
    this._lastScopedGfxFitKey = this._gfxViewportBridge.createFitKey();
    this._preserveScopedGfxViewportForNodeId = "";
    this._preservedScopedGfxViewport = null;
    if (
      this._isInEdgelessMode() &&
      this._visualSelectionAnchorKey("node") === insertedNodeId
    ) {
      this._pendingInsertedVisualNodeLabelCommitId = insertedNodeId;
      this._startInlineNodeTextEdit(null, insertedNodeId);
      if (!this._hasActiveInlineShapeTextEditor()) {
        this._pendingInsertedVisualNodeLabelCommitId = "";
      }
    }
    return true;
  }

  protected _findVisualEdgeByModelPoint(x: number, y: number) {
    return this._gfxViewportBridge.findEdgeByModelPoint(
      this._getMermaidVisualModelForEditing(),
      x,
      y,
    );
  }

  protected _selectVisualEdge(edgeId: string) {
    this._visualInspectorSuppressed = false;
    this._applyVisualSelectionPatch(selectMermaidGfxEdgePatch(edgeId));
    this.requestUpdate();
    this._scheduleScopedGfxSelectionVisibility();
  }

  protected _insertPendingVisualNode(
    point: { x: number; y: number },
    shape: MermaidVisualNodeShape,
  ) {
    const resolution = resolveMermaidGfxProjection(this.model);
    if (!resolution || resolution.displayOnly) return "";
    const insert = resolveMermaidGfxPendingNodeInsert({
      ownerXywh: resolution.ownerXYWH,
      modelPoint: point,
      pendingShape: shape,
    });
    if (!insert) return "";
    if (this._pendingVisualNodePlacement) {
      const onPlace = this._pendingVisualNodePlacement;
      this._pendingVisualNodePlacement = null;
      this._pendingVisualInsertShape = null;
      onPlace({ centerX: insert.centerX, centerY: insert.centerY });
      this.requestUpdate();
      return "";
    }
    const visualModel = this._getMermaidVisualModelForEditing();
    // The command below uses this same pure family factory. Resolve its stable
    // semantic id up front solely to name the shared placement/label history
    // boundary; the command remains the only Store and Source writer.
    const predictedNodeId = visualModel
      ? createMermaidGfxVisualNode(visualModel, insert.shape, {
          centerX: insert.centerX,
          centerY: insert.centerY,
        })?.id
      : undefined;
    if (!predictedNodeId) return "";
    this._preservedScopedGfxViewport =
      this._gfxViewportBridge.captureViewport();
    // Store the semantic selection intent before the command writes Source.
    // Store observers may replace and mount the scoped projection
    // synchronously while the command is still on the stack; queuing only
    // afterwards misses that projection-ready boundary and leaves a correctly
    // created node unselected.
    this._preserveScopedGfxViewportForNodeId = predictedNodeId;
    this._queueVisualSelectionForProjection([
      { editKey: predictedNodeId, kind: "node" },
    ]);
    let nodeId = "";
    const applied = this._applyGfxMutation(
      () => {
        const [ok, result] = this.std.command.exec(addMermaidGfxNodeCommand, {
          centerX: insert.centerX,
          centerY: insert.centerY,
          model: this.model,
          shape: insert.shape,
        });
        nodeId = result?.nodeId ?? "";
        return ok;
      },
      { coalesceKey: `visual-node-insert:${predictedNodeId}` },
    );
    if (!applied) {
      this._clearPendingVisualSelectionProjection();
      this._preserveScopedGfxViewportForNodeId = "";
      this._preservedScopedGfxViewport = null;
      return "";
    }
    if (
      nodeId !== predictedNodeId &&
      this._preserveScopedGfxViewportForNodeId === predictedNodeId
    ) {
      this._preserveScopedGfxViewportForNodeId = nodeId;
      this._queueVisualSelectionForProjection([
        { editKey: nodeId, kind: "node" },
      ]);
    }
    this._applyVisualSelectionPatch(insertMermaidGfxNodeSelectionPatch(nodeId));
    this._gfxViewportBridge.restoreViewport(this._preservedScopedGfxViewport);
    return nodeId;
  }

  protected _startInlineNodeTextEdit(
    event: Pick<Event, "preventDefault" | "stopPropagation"> | null,
    nodeId: string,
    hitModel?: unknown,
  ) {
    const detailKey = readMermaidGfxMeta(hitModel, "mermaidDetailSourceKey");
    if (
      this._consumeVisualObjectIntent({
        kind: detailKey ? "detail" : "node",
        id: detailKey || nodeId,
        ownerId: detailKey ? nodeId : undefined,
      })
    ) {
      event?.preventDefault();
      event?.stopPropagation();
      return;
    }
    if (
      this._getMermaidVisualModelForEditing()?.nodes.find(
        (node) => node.id === nodeId,
      )?.labelEditable === false
    ) {
      return;
    }
    const isRelationshipDetail = Boolean(
      readMermaidGfxMeta(hitModel, "mermaidDetailOwnerNodeId"),
    );
    // Hit testing can retain a transient GFX model while owner
    // reconciliation has already replaced the store-backed instance. Always
    // prefer the current model by semantic node id for ordinary nodes. Class,
    // ER and Requirement detail rows intentionally share their owner's node id
    // and therefore must keep the concrete detail hit model.
    const model = isRelationshipDetail
      ? hitModel
      : (this._getVisualNodeGfxModel(nodeId) ?? hitModel);
    if (!(model instanceof ShapeElementModel) || model.isLocked()) return;
    const shapeModel: ShapeElementModel = model;
    const visualModel = this._getMermaidVisualModelForEditing();
    const typeOwnedInitialValue = visualModel
      ? resolveTypeOwnedMermaidNodeInlineValue(visualModel, nodeId)
      : { handled: false as const };

    event?.preventDefault();
    event?.stopPropagation();
    this._selectVisualNode(nodeId);
    this._inlineShapeTextEditor.start({
      commitValue: isRelationshipDetail
        ? undefined
        : (label) => {
            const visualModel = this._getMermaidVisualModelForEditing();
            const typeOwned = visualModel
              ? resolveTypeOwnedMermaidNodeInlineRename(
                  visualModel,
                  nodeId,
                  label,
                  getMermaidBlockSource(this.model.props),
                )
              : { handled: false as const };
            return this._applyGfxMutation(
              () =>
                typeOwned.handled && typeOwned.visualModel
                  ? this.std.command.exec(applyMermaidVisualModelCommand, {
                      model: this.model,
                      visualModel: typeOwned.visualModel,
                    })[1]?.applied === true
                  : typeOwned.handled
                    ? false
                    : this.std.command.exec(applyMermaidGfxNodeCommand, {
                        label,
                        model: this.model,
                        nodeId,
                      })[0],
              {
                coalesceKey:
                  this._pendingInsertedVisualNodeLabelCommitId === nodeId
                    ? `visual-node-insert:${nodeId}`
                    : undefined,
              },
            );
          },
      model: shapeModel,
      initialValue:
        (typeOwnedInitialValue.handled
          ? typeOwnedInitialValue.value
          : visualModel?.nodes.find((node) => node.id === nodeId)?.label) ??
        shapeModel.text?.toString?.(),
      onClose: () => {
        if (this._pendingInsertedVisualNodeLabelCommitId === nodeId) {
          this._pendingInsertedVisualNodeLabelCommitId = "";
        }
      },
      resolveModel: isRelationshipDetail
        ? () => shapeModel
        : () => {
            const current = this._getVisualNodeGfxModel(nodeId);
            return current instanceof ShapeElementModel ? current : null;
          },
    });
  }

  protected _startSelectedVisualNodeTextEdit = () => {
    const nodeId = this._visualSelectionAnchorKey("node");
    if (!nodeId) return;
    this._startInlineNodeTextEdit(null, nodeId);
  };

  protected _startInlineEdgeTextEdit(
    event: MouseEvent | null,
    edgeId: string,
    point: { x: number; y: number },
  ) {
    if (this._consumeVisualObjectIntent({ kind: "edge", id: edgeId })) {
      event?.preventDefault();
      event?.stopPropagation();
      return;
    }
    if (
      this._getMermaidVisualModelForEditing()?.edges.find(
        (edge) => edge.id === edgeId,
      )?.labelEditable === false
    ) {
      return;
    }
    const connector = this._getVisualEdgeGfxModel(edgeId);
    if (
      !(connector instanceof ConnectorElementModel) ||
      connector.isLocked() ||
      connector.labelEditing
    ) {
      return;
    }

    const editorHost = this._getScopedGfxEditorHost();
    if (!editorHost) return;

    event?.preventDefault();
    event?.stopPropagation();
    this._pauseProjectionOwnerSourceSync();
    this._selectVisualEdge(edgeId);
    this._inlineConnectorLabelEditor.start({
      connector,
      editorHost,
      point: [point.x, point.y],
    });
  }

  protected _startInlineSubgraphTextEdit(
    event: MouseEvent | null,
    subgraphId: string,
  ) {
    if (this._consumeVisualObjectIntent({ kind: "subgraph", id: subgraphId })) {
      event?.preventDefault();
      event?.stopPropagation();
      return;
    }
    const visualModel = this._getMermaidVisualModelForEditing();
    if (!visualModel) return;
    const visualSubgraph = visualModel.subgraphs?.find(
      (subgraph) => subgraph.id === subgraphId,
    );
    const typeOwnedInitialValue = resolveTypeOwnedMermaidSubgraphInlineValue(
      visualModel,
      subgraphId,
    );
    const currentTitle = typeOwnedInitialValue.handled
      ? typeOwnedInitialValue.value
      : (visualSubgraph?.title.split("\n")[0] ?? "");
    if (
      !resolveTypeOwnedMermaidSubgraphInlineRename(
        visualModel,
        subgraphId,
        currentTitle,
      ).handled
    ) {
      return;
    }
    const model = this._getVisualSubgraphGfxModel(subgraphId);
    // Managed Mermaid groups use custom semantic controls. A native GFX
    // wrapper's constructor identity or ancestor lock may suppress generic
    // canvas mutation, but neither is authoritative for the typed Source
    // command. The bridge already resolved the persisted subgraph-shape role;
    // store readonly is the remaining semantic authority.
    if (!model || this.store.readonly) return;
    event?.preventDefault();
    event?.stopPropagation();
    if (this._visualSelectionAnchorKey("subgraph") !== subgraphId) {
      this._selectVisualSubgraph(subgraphId);
    }
    this._inlineShapeTextEditor.start({
      ariaLabel: mermaidMessages.selectedSubgraphTitle(),
      commitValue: (title) => {
        if (title === currentTitle) return false;
        const typeOwned = resolveTypeOwnedMermaidSubgraphInlineRename(
          visualModel,
          subgraphId,
          title,
          getMermaidBlockSource(this.model.props),
        );
        if (!typeOwned.handled) return false;
        if (!typeOwned.visualModel) return false;
        return this._applyGfxMutation(
          () =>
            this.std.command.exec(applyMermaidVisualModelCommand, {
              model: this.model,
              visualModel: typeOwned.visualModel!,
            })[1]?.applied === true,
        );
      },
      model,
      initialValue: currentTitle,
      resolveModel: () => this._getVisualSubgraphGfxModel(subgraphId),
      syncNodeMetadata: false,
      verticalPlacement: "top-line",
    });
  }

  protected _getScopedGfxEditorHost(): BlockComponent | null {
    const viewport = this._getScopedGfxViewport();
    // Connector label editing still uses the native GFX editor and therefore
    // must mount in the same Surface/CRUD context as the projection owner.
    return (
      (viewport?.querySelector("myoxus-surface") as BlockComponent | null) ??
      (viewport?.querySelector("editor-host") as BlockComponent | null)
    );
  }

  protected _handleConnectSelectedVisualNodesFromContext = () => {
    const connection = resolveMermaidGfxContextConnection({
      isReadonly: this.store.readonly,
      nodeOrder: this._visualSelectionKeys("node"),
    });
    if (!connection) return;
    if (
      getMermaidGfxFamilyHooks(this._getMermaidVisualModelForEditing())
        ?.connectionsViaFamilyControls &&
      this._consumeVisualObjectIntent({
        kind: "node",
        id: connection.sourceNodeId,
        connection,
      })
    ) {
      this._visualContextMenu = null;
      return;
    }
    let edgeId = "";
    const applied = this._applyGfxMutation(() => {
      const [ok, result] = this.std.command.exec(addMermaidGfxEdgeCommand, {
        model: this.model,
        sourceNodeId: connection.sourceNodeId,
        targetNodeId: connection.targetNodeId,
      });
      edgeId = result?.edgeId ?? "";
      return ok;
    });
    const result = resolveMermaidGfxContextConnectionResult({
      applied,
      edgeId,
      targetNodeId: connection.targetNodeId,
    });
    if (result.kind === "none") return;
    this._visualContextMenu = null;
    this._applyVisualSelectionPatch(
      connectMermaidGfxSelectionPatch(connection.targetNodeId),
    );
    this._fitScopedGfxViewport();
    requestAnimationFrame(() => this._fitScopedGfxViewport());
    if (result.kind === "select-edge") {
      this._selectVisualEdge(result.edgeId);
      return;
    }
    this.requestUpdate();
  };

  protected _moveVisualNodeByDrag(nodeId: string, dx: number, dy: number) {
    const active = this._transientVisualNodeDrag;
    if (
      this.store.readonly ||
      (active &&
        (active.source !== getMermaidBlockSource(this.model.props) ||
          active.viewportIdentity !==
            (this._getScopedGfxController()?.viewport ??
              this._getScopedGfxViewport())))
    ) {
      this._cancelTransientVisualNodeDrag();
      this._visualNodeDragModel = null;
      return;
    }
    // Pointer movement is a preview, not a sequence of persisted commands.
    // Keep the native shape bound stashed locally for the complete gesture so
    // neither the projection owner nor the remaining graph is resized/reprojected
    // underneath the pointer. Pointerup commits the accumulated model once.
    const dragModel =
      this._visualNodeDragModel ?? this._getMermaidVisualModelForEditing();
    const nodeSelection = this._visualSelectionKeys("node");
    const selectedNodeIds = dragModel
      ? typeOwnedMermaidGeometrySelection(
          dragModel,
          nodeSelection.includes(nodeId) ? nodeSelection : [nodeId],
        )
      : [];
    const scopedElement = this._getVisualNodeGfxModel(nodeId);
    if (!(scopedElement instanceof ShapeElementModel) || !dragModel) return;
    this._pauseProjectionOwnerSourceSync();
    if (
      !this._transientVisualNodeDrag ||
      this._transientVisualNodeDrag.nodeIds.join("\u0000") !==
        selectedNodeIds.join("\u0000")
    ) {
      this._cancelTransientVisualNodeDrag();
      // The scoped Page surface and the projection owner expose distinct model
      // wrappers backed by the same Y.Map. A pointer preview must never move
      // both wrappers: doing so creates two competing projection owners and
      // lets owner/path observers alternate geometry during one gesture. Keep
      // the preview exclusively on the visible scoped surface; pointerup owns
      // the single semantic/model commit to the projection owner.
      const elements = selectedNodeIds
        .flatMap((selectedNodeId) => [
          this._getVisualNodeGfxModel(selectedNodeId),
          // Detail rows are one semantic node projection, not independent
          // drag owners. Keep them in the same local preview transaction so
          // labels and Architecture icons never lag behind their node.
          ...this._getVisualNodeGfxDetailModels(selectedNodeId),
        ])
        .filter(
          (element): element is ShapeElementModel =>
            element instanceof ShapeElementModel,
        )
        .map((element) => {
          const initialXywh = element.xywh;
          element.stash("xywh");
          return { element, initialXywh };
        });
      const connectors = [
        ...new Set(
          elements.flatMap(({ element }) => [
            ...(element.surface as SurfaceBlockModel).getConnectors(element.id),
          ]),
        ),
      ]
        .filter(
          (connector): connector is ConnectorElementModel =>
            connector instanceof ConnectorElementModel,
        )
        .map((connector) => {
          const initialXywh = connector.xywh;
          const initialPath = connector.path;
          const initialLabelXYWH = connector.labelXYWH;
          // The connector watcher owns local path/bounds. Only labelXYWH is
          // a Y.Map field: rebasing local xywh to a Y.Map value would erase it.
          connector.stash("labelXYWH");
          return {
            element: connector,
            initialLabelXYWH,
            initialPath,
            initialXywh,
          };
        });
      const subgraphs = (dragModel.subgraphs ?? []).flatMap((subgraph) => {
        const element = this._getVisualSubgraphGfxModel(subgraph.id);
        if (!(element instanceof ShapeElementModel)) return [];
        const initialXywh = element.xywh;
        element.stash("xywh");
        return [{ element, initialXywh }];
      });
      this._transientVisualNodeDrag = {
        connectors,
        elements,
        nodeIds: [...selectedNodeIds],
        startModel: dragModel,
        source: getMermaidBlockSource(this.model.props),
        viewportIdentity:
          this._getScopedGfxController()?.viewport ??
          this._getScopedGfxViewport(),
        subgraphs,
      };
    }
    for (const { element } of this._transientVisualNodeDrag.elements) {
      element.xywh = Bound.deserialize(element.xywh)
        .moveDelta(dx, dy)
        .serialize();
    }
    this._visualNodeDragModel = selectedNodeIds.reduce(
      (model, selectedNodeId) =>
        accumulateMermaidGfxNodeDrag(model, selectedNodeId, dx, dy),
      dragModel,
    );
    this._refreshScopedGfxRenderer();
    this.requestUpdate();
  }

  private _cancelTransientVisualNodeDrag() {
    const transient = this._transientVisualNodeDrag;
    this._transientVisualNodeDrag = null;
    if (!transient) return;
    for (const { element, initialXywh } of transient.elements) {
      element.xywh = initialXywh;
      element.pop("xywh");
    }
    for (const { element, initialXywh } of transient.subgraphs) {
      element.xywh = initialXywh;
      element.pop("xywh");
    }
    // The node reset wakes the connector watcher. Let its local path/bounds
    // calculation settle while the persistent label bound is still stashed,
    // then restore the exact pre-gesture state without creating a Yjs write.
    queueMicrotask(() => {
      for (const connector of transient.connectors) {
        connector.element.xywh = connector.initialXywh;
        connector.element.path = connector.initialPath;
        connector.element.labelXYWH = connector.initialLabelXYWH;
        connector.element.pop("labelXYWH");
      }
      this._refreshScopedGfxRenderer();
    });
    this._refreshScopedGfxRenderer();
  }

  private _releaseTransientVisualNodeDrag(
    transient: NonNullable<MermaidHostGfxSelection["_transientVisualNodeDrag"]>,
  ) {
    // `pop()` commits the wrapper's stashed value back into its Y.Map. That is
    // correct for an ordinary native edit, but this scoped wrapper is only a
    // pointer preview: applyMermaidVisualModelCommand has already committed
    // canonical owner-relative geometry and may have resized the owner bound.
    // Rebase every local stash to that committed Y.Map value before popping so
    // the absolute preview cannot overwrite the owner's transformed geometry.
    for (const { element } of transient.elements) {
      releaseMermaidGfxPreviewProperty(element, "xywh");
    }
    for (const { element } of transient.subgraphs) {
      releaseMermaidGfxPreviewProperty(element, "xywh");
    }
    for (const { element } of transient.connectors) {
      releaseMermaidGfxPreviewProperty(element, "labelXYWH");
    }
  }

  protected _previewVisualNodeReparent(
    nodeId: string,
    targetSubgraphId: string,
  ) {
    this._visualSubgraphDropPreview = null;
    const visualModel = this._getMermaidVisualModelForEditing();
    if (!nodeId || !targetSubgraphId || !visualModel) {
      this.requestUpdate();
      return;
    }
    const nodeSelection = this._visualSelectionKeys("node");
    const selectedNodeIds = nodeSelection.includes(nodeId)
      ? nodeSelection
      : [nodeId];
    const hasMembershipChange = selectedNodeIds.some(
      (selectedNodeId) =>
        (visualModel.subgraphs?.find((subgraph) =>
          subgraph.nodeIds.includes(selectedNodeId),
        )?.id ?? "") !== targetSubgraphId,
    );
    const supported = reparentTypeOwnedMermaidGfxNodes(
      visualModel,
      selectedNodeIds,
      targetSubgraphId,
    );
    const model = this._getVisualSubgraphGfxModel(targetSubgraphId);
    const rect = model?.xywh
      ? this._gfxViewportBridge.getSubgraphMoveHandleViewRect(model.xywh)
      : null;
    if (supported && hasMembershipChange && rect) {
      this._visualSubgraphDropPreview = {
        ...rect,
        id: targetSubgraphId,
      };
    }
    this.requestUpdate();
  }

  protected _previewVisualSubgraphReparent(
    subgraphId: string,
    targetSubgraphId: string,
  ) {
    this._visualSubgraphDropPreview = null;
    const visualModel = this._getMermaidVisualModelForEditing();
    if (!subgraphId || !targetSubgraphId || !visualModel) {
      this.requestUpdate();
      return;
    }
    const currentParentId =
      visualModel.subgraphs?.find(({ id }) => id === subgraphId)?.parentId ??
      "";
    const supported = reparentTypeOwnedMermaidGfxSubgraph(
      visualModel,
      subgraphId,
      targetSubgraphId,
    );
    const model = this._getVisualSubgraphGfxModel(targetSubgraphId);
    const rect = model?.xywh
      ? this._gfxViewportBridge.getSubgraphMoveHandleViewRect(model.xywh)
      : null;
    if (supported && targetSubgraphId !== currentParentId && rect) {
      this._visualSubgraphDropPreview = {
        ...rect,
        id: targetSubgraphId,
      };
    }
    this.requestUpdate();
  }

  protected _reparentVisualSubgraph(
    subgraphId: string,
    parentId: string,
    coalesceKey: string,
  ) {
    this._visualSubgraphDropPreview = null;
    const visualModel = this._getMermaidVisualModelForEditing();
    const currentParentId =
      visualModel?.subgraphs?.find(({ id }) => id === subgraphId)?.parentId ??
      "";
    const reparented = visualModel
      ? reparentTypeOwnedMermaidGfxSubgraph(visualModel, subgraphId, parentId)
      : null;
    if (reparented && parentId !== currentParentId) {
      this._applyGfxMutation(
        () =>
          this.std.command.exec(applyMermaidVisualModelCommand, {
            model: this.model,
            visualModel: reparented,
          })[1]?.applied === true,
        { coalesceKey },
      );
    }
    this._selectVisualSubgraph(subgraphId);
    this._scheduleRender();
    this.requestUpdate();
  }

  protected _handleVisualNodeDragEnd(
    draggedNodeId: string,
    didMove: boolean,
    targetSubgraphId: string,
    cancelled: boolean,
    duplicate: boolean,
  ) {
    // A plain click starts the same pointer session as a drag. Only real
    // Movement should recalculate the containing subgraph. A plain click must
    // retain the more specific selected child instead of selecting its lane.
    this._visualSubgraphDropPreview = null;
    const dragModel = this._visualNodeDragModel;
    this._visualNodeDragModel = null;
    const transient = this._transientVisualNodeDrag;
    if (
      cancelled ||
      !didMove ||
      !draggedNodeId ||
      !transient ||
      this.store.readonly ||
      transient.source !== getMermaidBlockSource(this.model.props) ||
      transient.viewportIdentity !==
        (this._getScopedGfxController()?.viewport ??
          this._getScopedGfxViewport())
    ) {
      this._cancelTransientVisualNodeDrag();
      return;
    }
    if (duplicate) {
      const startNode = transient.startModel.nodes.find(
        (node) => node.id === draggedNodeId,
      );
      const movedNode = dragModel?.nodes.find(
        (node) => node.id === draggedNodeId,
      );
      this._cancelTransientVisualNodeDrag();
      if (!startNode || !movedNode) return;
      const offset = {
        x: movedNode.x - startNode.x,
        y: movedNode.y - startNode.y,
      };
      queueMicrotask(() => this._duplicateSelectedVisualNodes(offset));
      return;
    }
    const visualModel = dragModel ?? this._getMermaidVisualModelForEditing();
    const nodeSelection = this._visualSelectionKeys("node");
    const selectedNodeIds = nodeSelection.includes(draggedNodeId)
      ? nodeSelection
      : [draggedNodeId];
    const reparented = visualModel
      ? reparentTypeOwnedMermaidGfxNodes(
          visualModel,
          selectedNodeIds,
          targetSubgraphId,
        )
      : null;
    const reconcilesDragEnd = visualModel
      ? shouldReconcileTypeOwnedMermaidNodeDragEnd(visualModel)
      : null;
    // Families such as Architecture persist free geometry but deliberately do
    // not reinterpret a drop as generic subgraph membership. Their completed
    // drag model is authoritative even though no reparent hook is registered.
    const committedVisualModel =
      reparented ?? (reconcilesDragEnd === false ? visualModel : null);
    if (committedVisualModel) {
      const applied = this._applyGfxMutation(
        () =>
          this.std.command.exec(applyMermaidVisualModelCommand, {
            model: this.model,
            transientConnectorIds: transient.connectors.map(
              (connector) => connector.element.id,
            ),
            transientNodeIds: transient.nodeIds,
            transientSubgraphIds: transient.subgraphs.map(
              (subgraph) => subgraph.element.id,
            ),
            visualModel: committedVisualModel,
          })[1]?.applied === true,
        {
          deferUpdate: true,
        },
        transient.startModel,
      );
      if (!applied) {
        this._cancelTransientVisualNodeDrag();
        return;
      }
      this._transientVisualNodeDrag = null;
      this._releaseTransientVisualNodeDrag(transient);
      this._acceptProjectionOwnerSourceSyncKey();
      this._lastScopedGfxFitKey = this._gfxViewportBridge.createFitKey();
      this._scopedGfxFitRequestVersion += 1;
      // The pointer's drop position is authoritative, including placements at
      // or beyond a viewport edge. Reassert selection without the generic
      // ensure-visible path, which would pan a deliberate edge drop back into
      // the viewport immediately after pointerup.
      this._projectVisualSelectionToScopedGfx();
      this.requestUpdate();
      return;
    }
    this._cancelTransientVisualNodeDrag();
    this._lastScopedGfxFitKey = this._gfxViewportBridge.createFitKey();
    this._scheduleRender();
    requestAnimationFrame(() => {
      const latestVisualModel = this._getMermaidVisualModelForEditing();
      const subgraphId = resolveMermaidGfxNodeDragEndSubgraph({
        draggedNodeId,
        subgraphs: latestVisualModel?.subgraphs,
      });
      if (subgraphId) this._selectVisualSubgraph(subgraphId);
    });
    this.requestUpdate();
  }
}
