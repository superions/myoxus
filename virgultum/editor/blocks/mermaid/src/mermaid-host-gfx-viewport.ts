import { resolveMermaidGfxEdgeEndpointPositions } from "./families/runtime/gfx-host-contract.js";
import {
  typeOwnedMermaidConnectionTargetsIncludeSubgraphs,
  typeOwnedMermaidNodeConnectionPorts,
  typeOwnedMermaidSubgraphHeaderBehindContent,
} from "./families/runtime/gfx-owner-hooks.js";
import { MermaidHostGfxActions } from "./mermaid-host-gfx-actions.js";
import type { MermaidGfxDragViewportSnapshot } from "./mermaid-gfx-viewport-interaction-controller.js";

export abstract class MermaidHostGfxViewport extends MermaidHostGfxActions {
  protected _resolveDetailVisibilityTarget?: () => {
    ownerId: string;
    detailId: string;
  } | null;
  protected _getScopedViewPointFromClient(clientX: number, clientY: number) {
    return this._gfxViewportBridge.getViewPointFromClient(clientX, clientY);
  }

  protected _getVisualNodeGfxModel(nodeId: string) {
    return this._gfxViewportBridge.getNodeModel(nodeId);
  }

  protected _getVisualNodeGfxDetailModels(nodeId: string) {
    return this._gfxViewportBridge.getNodeDetailModels(nodeId);
  }

  protected _getVisualNodeConnectionHandles(nodeId: string) {
    const visualModel = this._getMermaidVisualModelForEditing();
    const model =
      this._getVisualNodeGfxModel(nodeId) ??
      (visualModel &&
      typeOwnedMermaidConnectionTargetsIncludeSubgraphs(visualModel)
        ? this._getVisualSubgraphGfxModel(nodeId)
        : null);
    const node = visualModel?.nodes.find(
      (candidate) => candidate.id === nodeId,
    );
    if (!model || !visualModel) return [];
    return (
      this._gfxViewportBridge.getNodeHandleViewPoints(
        model,
        node
          ? typeOwnedMermaidNodeConnectionPorts(visualModel, node)
          : undefined,
      )?.connectPorts ?? []
    );
  }

  protected _getVisualEdgeGfxModel(edgeId: string) {
    return this._gfxViewportBridge.getEdgeModel(edgeId);
  }

  protected _getVisualSubgraphGfxModel(subgraphId: string) {
    return this._gfxViewportBridge.getSubgraphModel(subgraphId);
  }

  // These projections deliberately read the current scoped model and viewport
  // on demand. Handle coordinates are render output, not host state: caching
  // them or retaining a model wrapper across an owner lets an old pointermove
  // overwrite the chrome after a newer drag preview or pointerup commit.
  protected _getSelectedVisualNodeHandleProjection() {
    const visualModel = this._getMermaidVisualModelForEditing();
    const nodeId =
      this._visualSelectionAnchorKey("node") ||
      (visualModel &&
      typeOwnedMermaidConnectionTargetsIncludeSubgraphs(visualModel)
        ? this._visualSelectionAnchorKey("subgraph")
        : "");
    const model = nodeId
      ? (this._getVisualNodeGfxModel(nodeId) ??
        this._getVisualSubgraphGfxModel(nodeId))
      : null;
    const node = visualModel?.nodes.find(
      (candidate) => candidate.id === nodeId,
    );
    if (!model?.xywh || !visualModel) return null;
    return this._gfxViewportBridge.getNodeHandleViewPoints(
      model,
      node ? typeOwnedMermaidNodeConnectionPorts(visualModel, node) : undefined,
    );
  }

  protected _getSelectedVisualNodeHandles() {
    return this._getSelectedVisualNodeHandleProjection()?.connectPorts ?? [];
  }

  protected _getSelectedVisualEdgeHandles() {
    const visualModel = this._getMermaidVisualModelForEditing();
    const edge = visualModel?.edges.find(
      (candidate) => candidate.id === this._visualSelectionAnchorKey("edge"),
    );
    if (!edge) return null;
    const sourceModel = edge.sourceAttachment
      ? (this._getVisualSubgraphGfxModel(edge.sourceAttachment) ??
        this._getVisualNodeGfxModel(edge.sourceAttachment))
      : (this._getVisualNodeGfxModel(edge.source) ??
        (visualModel &&
        typeOwnedMermaidConnectionTargetsIncludeSubgraphs(visualModel)
          ? this._getVisualSubgraphGfxModel(edge.source)
          : null));
    const targetModel = edge.targetAttachment
      ? (this._getVisualSubgraphGfxModel(edge.targetAttachment) ??
        this._getVisualNodeGfxModel(edge.targetAttachment))
      : (this._getVisualNodeGfxModel(edge.target) ??
        (visualModel &&
        typeOwnedMermaidConnectionTargetsIncludeSubgraphs(visualModel)
          ? this._getVisualSubgraphGfxModel(edge.target)
          : null));
    if (!sourceModel?.xywh || !targetModel?.xywh) return null;
    return this._gfxViewportBridge.getEdgeHandleViewPoints({
      ...resolveMermaidGfxEdgeEndpointPositions(edge),
      sourceXywh: sourceModel.xywh,
      targetXywh: targetModel.xywh,
    });
  }

  protected _getSelectedVisualSubgraphHandleProjection() {
    const subgraphId = this._visualSelectionAnchorKey("subgraph");
    const model = subgraphId
      ? this._getVisualSubgraphGfxModel(subgraphId)
      : null;
    if (!model?.xywh) return null;
    const move = this._gfxViewportBridge.getSubgraphMoveHandleViewRect(
      model.xywh,
    );
    const resize = this._gfxViewportBridge.getSubgraphResizeHandleViewPoint(
      model.xywh,
    );
    return move && resize ? { move, resize } : null;
  }

  protected _findVisualNodeByClientPoint(clientX: number, clientY: number) {
    return this._gfxViewportBridge.findNodeByClientPoint(clientX, clientY);
  }

  protected _findVisualNodeModelByClientPoint(
    clientX: number,
    clientY: number,
  ) {
    return this._gfxViewportBridge.findNodeModelByClientPoint(clientX, clientY);
  }

  protected _getScopedGfxViewport() {
    return this._gfxViewportBridge.getViewportElement();
  }

  protected _getScopedGfxController() {
    return this._gfxViewportBridge.getController();
  }

  protected _captureScopedGfxViewport() {
    const viewport = this._gfxViewportBridge.captureViewport();
    if (!viewport) return null;
    const mode = "visual" as const;
    return {
      ...viewport,
      mode,
      position: this._pageViewportState.positions[mode],
    };
  }

  protected _restoreScopedGfxViewport(
    snapshot: MermaidGfxDragViewportSnapshot | null,
  ) {
    if (!snapshot) return;
    this._transitionPageViewport({
      mode: snapshot.mode,
      position: snapshot.position,
      type: "position",
    });
    this._gfxViewportBridge.restoreViewport(snapshot);
  }

  protected _refreshScopedGfxRenderer() {
    const surfaceComponent = this._getScopedGfxController()
      ?.surfaceComponent as { refresh?: () => void } | null | undefined;
    surfaceComponent?.refresh?.();
  }

  protected _getScopedModelPointFromClient(clientX: number, clientY: number) {
    return this._gfxViewportBridge.getModelPointFromClient(clientX, clientY);
  }

  protected _getScopedModelDeltaFromClient(dx: number, dy: number) {
    return this._gfxViewportBridge.getModelDeltaFromClient(dx, dy);
  }

  protected _panScopedGfxViewportNearClientPoint(
    clientX: number,
    clientY: number,
    maxViewDelta?: number,
  ) {
    return this._gfxViewportBridge.panViewportNearClientPoint(
      clientX,
      clientY,
      maxViewDelta,
    );
  }

  protected _setVisualNodePointerSessionActive(active: boolean) {
    this._visualNodePointerSessionActive = active;
    if (active) this._markScopedGfxViewportUserPositioned();
  }

  protected _markScopedGfxViewportUserPositioned() {
    this._scopedGfxViewportUserPositioned = true;
    this._scopedGfxFitRequestVersion += 1;
  }

  protected _findVisualSubgraphByModelPoint(x: number, y: number) {
    return this._gfxViewportBridge.findSubgraphByModelPoint(x, y);
  }

  protected _findVisualSubgraphCollapseByModelPoint(x: number, y: number) {
    return this._gfxViewportBridge.findSubgraphCollapseByModelPoint(x, y);
  }

  protected _findVisualSubgraphHeaderByModelPoint(x: number, y: number) {
    const visualModel = this._getMermaidVisualModelForEditing();
    if (
      visualModel &&
      typeOwnedMermaidSubgraphHeaderBehindContent(visualModel) &&
      (this._gfxViewportBridge.findNodeByModelPoint(x, y) ||
        this._findVisualEdgeByModelPoint(x, y))
    ) {
      return "";
    }
    return this._gfxViewportBridge.findSubgraphHeaderByModelPoint(x, y);
  }

  protected _fitScopedGfxViewport() {
    // Explicit Page Auto and passive Notes fit the complete owner. An opened
    // Note uses the family's readable initial camera.
    this._gfxViewportBridge.fitViewport(
      (this._isInEdgelessMode() && !this._isActiveEmbeddedGfxEditor()) ||
        (!this._isInEdgelessMode() && this._pageViewportState.zoom === "auto")
        ? null
        : undefined,
    );
    this._reconcileScopedGfxSelectionViewport();
  }

  protected _zoomScopedGfxViewportToActualSize() {
    this._gfxViewportBridge.zoomViewportTo(1);
    this._reconcileScopedGfxSelectionViewport();
  }

  protected _ensureScopedGfxSelectionVisible() {
    const nodeId = this._visualSelectionAnchorKey("node");
    const edgeId = this._visualSelectionAnchorKey("edge");
    const subgraphId = this._visualSelectionAnchorKey("subgraph");
    if (nodeId) {
      const detail = this._resolveDetailVisibilityTarget?.();
      if (
        detail?.ownerId === nodeId &&
        this._gfxViewportBridge.ensureDetailVisible(nodeId, detail.detailId)
      ) {
        return;
      }
      this._gfxViewportBridge.ensureNodeVisible(nodeId);
    } else if (edgeId) {
      this._gfxViewportBridge.ensureEdgeVisible(edgeId);
    } else if (subgraphId) {
      this._gfxViewportBridge.ensureSubgraphVisible(subgraphId);
    }
  }

  protected _reconcileScopedGfxSelectionViewport() {
    this._ensureScopedGfxSelectionVisible();
    this.requestUpdate();
  }

  protected _scheduleScopedGfxSelectionVisibility() {
    requestAnimationFrame(() => {
      if (
        !this._visualNodePointerSessionActive &&
        !this._visualInspectorSuppressed &&
        !this._preserveScopedGfxViewportForNodeId
      ) {
        this._ensureScopedGfxSelectionVisible();
      }
    });
  }

  protected _fitScopedGfxViewportIfNeeded() {
    if (this._mode !== "visual" || !this._getScopedGfxViewport()) return;
    const key = this._gfxViewportBridge.createFitKey();
    if (this._pageViewportState.zoom !== "auto") {
      if (key) this._lastScopedGfxFitKey = key;
      return;
    }
    if (this._scopedGfxViewportUserPositioned) {
      // Direct manipulation and navigation make the current camera
      // authoritative. Source reconciliation may legitimately change the
      // owner key, but it must not reinterpret that change as permission to
      // fit the entire diagram underneath the pointer after drop.
      if (key) this._lastScopedGfxFitKey = key;
      this._scopedGfxFitRequestVersion += 1;
      return;
    }
    if (this._preserveScopedGfxViewportForNodeId) {
      // Direct placement owns the pointer anchor. Frame reconciliation may
      // emit more than one fit key while the inserted GFX element and source
      // settle; accept each key without moving the viewport until selection
      // hydration confirms the new node is stable.
      if (key) this._lastScopedGfxFitKey = key;
      this._gfxViewportBridge.restoreViewport(this._preservedScopedGfxViewport);
      return;
    }
    if (!key || key === this._lastScopedGfxFitKey) return;
    this._lastScopedGfxFitKey = key;
    const requestVersion = ++this._scopedGfxFitRequestVersion;
    requestAnimationFrame(() => {
      if (requestVersion !== this._scopedGfxFitRequestVersion) return;
      this._fitScopedGfxViewport();
    });
  }

  protected _refreshPageGfxViewport() {
    if (
      this._pageViewportState.zoom === "auto" &&
      !this._scopedGfxViewportUserPositioned
    ) {
      this._fitScopedGfxViewport();
      const mode = "visual";
      const scale = this._gfxViewportBridge.captureViewport()?.zoom;
      if (scale) {
        this._transitionPageViewport({ mode, scale, type: "resolved-scale" });
      }
    } else {
      this._reconcileScopedGfxSelectionViewport();
    }
  }
}
