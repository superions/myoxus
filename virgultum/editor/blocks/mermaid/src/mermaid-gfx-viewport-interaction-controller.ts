// SPDX-License-Identifier: AGPL-3.0-or-later

import { IS_MAC } from "@virgultum/global/env";

import type { MermaidVisualNodeShape } from "./families/runtime/gfx-model.js";
import {
  resolveMermaidGfxContextMenuPosition,
  resolveMermaidGfxContextMenuSelection,
} from "./mermaid-gfx-context-menu.js";
import {
  type MermaidGfxPoint,
  resolveMermaidGfxNodeDragDelta,
} from "./mermaid-gfx-drag.js";
import {
  isMermaidGfxButtonTarget,
  isMermaidGfxInterfaceControlEventPath,
  isMermaidGfxNativeControlEventPath,
  type MermaidGfxViewportSelectionIntent,
  resolveMermaidGfxViewportSelectionIntent,
  shouldIgnoreMermaidGfxViewportClick,
  shouldIgnoreMermaidGfxViewportContextMenu,
  shouldIgnoreMermaidGfxViewportDoubleClick,
  shouldIgnoreMermaidGfxViewportPointerDown,
} from "./mermaid-gfx-events.js";
import { getMermaidGfxSelectionIdentity } from "./mermaid-gfx-selection.js";
import type { MermaidPageSelectionTool } from "./mermaid-page-selection-state.js";

type MermaidGfxViewportInteractionPoint = MermaidGfxPoint;

export type MermaidGfxDragViewportSnapshot = {
  center: [number, number];
  mode: "view" | "visual";
  position: {
    scrollLeft: number;
    scrollTop: number;
  };
  zoom: number;
};

const MERMAID_DRAG_EDGE_PAN_MAX_FRAME_MS = 50;
const MERMAID_DRAG_EDGE_PAN_VIEW_SPEED_PX_PER_SECOND = 240;

function hasMermaidNodeSelectionToggleModifier(
  event: MouseEvent | PointerEvent,
) {
  return event.shiftKey || (IS_MAC ? event.metaKey : event.ctrlKey);
}

function isNativeMacContextClick(event: MouseEvent | PointerEvent) {
  return IS_MAC && event.ctrlKey && !event.metaKey;
}

function isSubgraphMoveHandle(target: EventTarget | null) {
  return (
    target instanceof Element &&
    Boolean(target.closest(".myoxus-mermaid-gfx-subgraph-move-handle"))
  );
}

export type MermaidGfxViewportInteractionHost = {
  activateScopedEditor?(): void;
  consumeNodeDragStart?(event: PointerEvent): boolean;
  consumeObjectIntent?(event: MouseEvent, phase: "pointer" | "edit"): boolean;
  canConsumeViewportEvent(): boolean;
  captureViewport(): MermaidGfxDragViewportSnapshot | null;
  clearVisualSelection(): void;
  findVisualEdgeByModelPoint(x: number, y: number): string;
  findVisualNodeByClientPoint(clientX: number, clientY: number): string;
  findVisualNodeModelByClientPoint(clientX: number, clientY: number): unknown;
  findVisualSubgraphByModelPoint(x: number, y: number): string;
  findVisualSubgraphHeaderByModelPoint(x: number, y: number): string;
  getExplicitVisualNodeOrder(): readonly string[];
  getPendingVisualInsertShape(): MermaidVisualNodeShape | null;
  getPageSelectionTool(): MermaidPageSelectionTool;
  getScopedGfxViewport(): Element | null;
  getScopedModelDeltaFromClient(
    dx: number,
    dy: number,
  ): { dx: number; dy: number } | null;
  getScopedModelPointFromClient(
    clientX: number,
    clientY: number,
  ): MermaidGfxViewportInteractionPoint | null;
  getSelectedVisualNodeId(): string;
  getSelectedVisualEdgeId(): string;
  getSelectedVisualNodeOrder(): readonly string[];
  insertPendingVisualNode(
    point: MermaidGfxViewportInteractionPoint,
    shape: MermaidVisualNodeShape,
  ): string;
  isConnectingVisualNodes(): boolean;
  isEditableEventTarget(event: Event): boolean;
  isReadonly(): boolean;
  moveVisualNode(nodeId: string, dx: number, dy: number): void;
  onVisualNodeDragEnd(
    nodeId: string,
    didMove: boolean,
    targetSubgraphId: string,
    cancelled: boolean,
    duplicate: boolean,
  ): void;
  panViewportNearClientPoint(
    clientX: number,
    clientY: number,
    maxViewDelta?: number,
  ): { dx: number; dy: number } | null;
  previewVisualNodeReparent(nodeId: string, targetSubgraphId: string): void;
  requestUpdate(): void;
  restoreViewport(snapshot: MermaidGfxDragViewportSnapshot | null): void;
  selectVisualEdge(edgeId: string): void;
  selectVisualNode(nodeId: string, additive?: boolean): boolean;
  selectVisualSubgraph(subgraphId: string): void;
  setVisualNodePointerSessionActive(active: boolean): void;
  setSelectedVisualNodeOrder(nodeOrder: readonly string[]): void;
  setVisualInspectorSuppressed(suppressed: boolean): void;
  setVisualContextMenu(menu: { left: number; top: number } | null): void;
  startInlineEdgeTextEdit(
    event: MouseEvent,
    edgeId: string,
    point: MermaidGfxViewportInteractionPoint,
  ): void;
  startInlineNodeTextEdit(
    event: MouseEvent,
    nodeId: string,
    model?: unknown,
  ): void;
  startInlineSubgraphTextEdit(event: MouseEvent, subgraphId: string): void;
};

/**
 * Owns Mermaid's scoped GFX viewport events while leaving model writes and
 * source synchronization in the block host. An embedded Edgeless consumer is
 * active only after its outer Note has entered the normal editing state.
 *
 * The controller is intentionally callback-driven. It can translate native
 * pointer/context-menu events into selection, insert, drag and label-edit
 * intents, but it cannot mutate Mermaid source or GFX documents by itself.
 */
export class MermaidGfxViewportInteractionController {
  private _didDragNode = false;
  private _duplicateNodeDrag = false;
  private _dragEdgePanRaf = 0;
  private _dragEdgePanLastTimestamp = 0;
  private _dragClientPoint: MermaidGfxViewportInteractionPoint | null = null;
  private _dragLastPoint: MermaidGfxViewportInteractionPoint | null = null;
  private _dragNodeId = "";
  private _dragPointerId: number | null = null;
  private _dragTargetSubgraphId = "";
  private _dragViewportSnapshot: MermaidGfxDragViewportSnapshot | null = null;
  private _lastViewportPointerTarget: {
    clientX: number;
    clientY: number;
    edgeId?: string;
    model?: unknown;
    nodeId?: string;
    point: MermaidGfxViewportInteractionPoint;
    subgraphId?: string;
    timestamp: number;
  } | null = null;
  private _skipNextClickSelection = false;
  private _objectPointerId: number | null = null;
  private _lastObjectPointerDown: {
    edited?: boolean;
    time: number;
    x: number;
    y: number;
  } | null = null;
  private readonly _handleObjectPointerUp = (event: PointerEvent) => {
    if (event.pointerId !== this._objectPointerId) return;
    this._stopObjectPointer();
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  private _stopObjectPointer() {
    this._objectPointerId = null;
    window.removeEventListener("pointerup", this._handleObjectPointerUp, true);
    window.removeEventListener(
      "pointercancel",
      this._handleObjectPointerUp,
      true,
    );
  }

  readonly clickListener = {
    capture: true,
    handleEvent: (event: Event) => {
      this.handleViewportClick(event as PointerEvent);
    },
  };

  readonly contextMenuListener = {
    capture: true,
    handleEvent: (event: Event) => {
      this.handleViewportContextMenu(event as MouseEvent);
    },
  };

  readonly doubleClickListener = {
    capture: true,
    handleEvent: (event: Event) => {
      this.handleViewportDoubleClick(event as MouseEvent);
    },
  };

  readonly pointerDownListener = {
    capture: true,
    handleEvent: (event: Event) => {
      this.handleViewportPointerDown(event as PointerEvent);
    },
  };

  constructor(private readonly host: MermaidGfxViewportInteractionHost) {}

  suppressNextClickSelection() {
    this._skipNextClickSelection = true;
  }

  clearPointerSelectionMemory() {
    this._lastViewportPointerTarget = null;
    this._lastObjectPointerDown = null;
  }

  stopTransientPointerInteractions() {
    this.cancelVisualNodeDrag();
    this._stopObjectPointer();
    this._lastObjectPointerDown = null;
  }

  cancelVisualNodeDrag() {
    if (!this._dragNodeId) return false;
    const draggedNodeId = this._dragNodeId;
    const viewportSnapshot = this._dragViewportSnapshot;
    this._stopVisualNodeDrag();
    this.host.restoreViewport(viewportSnapshot);
    this.host.onVisualNodeDragEnd(draggedNodeId, false, "", true, false);
    return true;
  }

  handleViewportClick(event: PointerEvent) {
    if (!this._isScopedViewportEvent(event)) return;
    if (this.host.getPageSelectionTool() === "box") return;
    if (
      shouldIgnoreMermaidGfxViewportClick({
        isButtonTarget: isMermaidGfxButtonTarget(event.target),
        isEditableTarget: this.host.isEditableEventTarget(event),
        isNativeControl: isMermaidGfxNativeControlEventPath(
          event.composedPath(),
        ),
      })
    ) {
      return;
    }
    // A drag may end without a canvas click. Its pending suppression must not
    // consume a later overlay control (for example an anchored comment marker).
    if (this._skipNextClickSelection) {
      this._skipNextClickSelection = false;
      this._claimViewportEvent(event);
      return;
    }
    const point = this.host.getScopedModelPointFromClient(
      event.clientX,
      event.clientY,
    );
    if (!point) return;
    if (event.detail >= 2) {
      this.handleViewportDoubleClick(event as unknown as MouseEvent);
      return;
    }

    const pointerTarget = this._getRecentViewportPointerTarget(event);
    const connectionTargetNodeId = this.host.isConnectingVisualNodes()
      ? this.host.findVisualNodeByClientPoint(event.clientX, event.clientY)
      : "";
    const intent = connectionTargetNodeId
      ? ({ kind: "node", nodeId: connectionTargetNodeId } as const)
      : pointerTarget?.nodeId
        ? ({ kind: "node", nodeId: pointerTarget.nodeId } as const)
        : pointerTarget?.edgeId
          ? ({ edgeId: pointerTarget.edgeId, kind: "edge" } as const)
          : this._resolveSelectionIntent(event, point);
    if (intent.kind === "node") {
      this._claimViewportEvent(event);
      const additive = hasMermaidNodeSelectionToggleModifier(event);
      const repeatsPointerSelection = pointerTarget?.nodeId === intent.nodeId;
      if (additive && repeatsPointerSelection) return;
      if (!repeatsPointerSelection) {
        this.host.setVisualInspectorSuppressed(additive);
      }
      const handled = this.host.selectVisualNode(intent.nodeId, additive);
      if (handled) {
        this.host.setVisualNodePointerSessionActive(false);
        return;
      }
      return;
    }
    if (intent.kind === "edge") {
      this._claimViewportEvent(event);
      this.host.selectVisualEdge(intent.edgeId);
      this._stabilizeVisualEdgeSelection(intent.edgeId);
      return;
    }
    if (intent.kind === "subgraph") {
      this._claimViewportEvent(event);
      this.host.selectVisualSubgraph(intent.subgraphId);
      return;
    }
    this._lastViewportPointerTarget = null;
    this.host.clearVisualSelection();
  }

  handleViewportContextMenu(event: MouseEvent) {
    if (!this._isScopedViewportEvent(event)) return;
    if (
      shouldIgnoreMermaidGfxViewportContextMenu({
        isButtonTarget: isMermaidGfxButtonTarget(event.target),
        isEditableTarget: this.host.isEditableEventTarget(event),
        isReadonly: this.host.isReadonly(),
      })
    ) {
      return;
    }
    const viewport = this.host.getScopedGfxViewport();
    if (!(viewport instanceof HTMLElement)) return;

    const nodeId = this.host.findVisualNodeByClientPoint(
      event.clientX,
      event.clientY,
    );
    const selectedNodeOrder = this.host.getSelectedVisualNodeOrder();
    if (nodeId && !selectedNodeOrder.includes(nodeId)) {
      this.host.selectVisualNode(nodeId, selectedNodeOrder.length === 1);
    }
    const intent = resolveMermaidGfxContextMenuSelection({
      explicitNodeOrder: this.host.getExplicitVisualNodeOrder(),
      nodeId,
      selectedNodeId: this.host.getSelectedVisualNodeId(),
      selectedNodeOrder: this.host.getSelectedVisualNodeOrder(),
    });
    if (intent.selectionAction) {
      this.host.selectVisualNode(
        intent.selectionAction.nodeId,
        intent.selectionAction.additive,
      );
    }
    if (!intent.canOpenMenu) return;
    this.host.setSelectedVisualNodeOrder(intent.menuNodeOrder);

    this._claimViewportEvent(event);
    const rect = viewport.getBoundingClientRect();
    const localWidth = viewport.clientWidth || rect.width;
    const localHeight = viewport.clientHeight || rect.height;
    const viewScale =
      rect.width > 0 && localWidth > 0 ? rect.width / localWidth : 1;
    this.host.setVisualContextMenu(
      resolveMermaidGfxContextMenuPosition({
        clientX: (event.clientX - rect.left) / viewScale,
        clientY: (event.clientY - rect.top) / viewScale,
        viewportRect: {
          height: localHeight,
          left: 0,
          top: 0,
          width: localWidth,
        },
      }),
    );
    this.host.requestUpdate();
  }

  handleViewportPointerDown(event: PointerEvent) {
    if (!this._isScopedViewportEvent(event)) return;
    if (isNativeMacContextClick(event)) return;
    if (event.button === 2) {
      this.handleViewportContextMenu(event as unknown as MouseEvent);
      return;
    }
    if (this.host.getPageSelectionTool() === "box") return;
    const previous = this._lastObjectPointerDown;
    const repeat =
      previous &&
      this._eventTimestamp(event) - previous.time < 500 &&
      Math.hypot(event.clientX - previous.x, event.clientY - previous.y) < 8;
    const moveHandle = isSubgraphMoveHandle(event.target);
    if (moveHandle || !isMermaidGfxButtonTarget(event.target)) {
      this._lastObjectPointerDown = {
        time: this._eventTimestamp(event),
        x: event.clientX,
        y: event.clientY,
      };
    }
    if (
      shouldIgnoreMermaidGfxViewportPointerDown({
        // The first click creates a move handle over the selected header.
        // Its second down still belongs to that object's typed edit intent.
        isButtonTarget:
          isMermaidGfxButtonTarget(event.target) && !(moveHandle && repeat),
        isConnecting: this.host.isConnectingVisualNodes(),
        isEditableTarget: this.host.isEditableEventTarget(event),
        isNativeControl: isMermaidGfxNativeControlEventPath(
          event.composedPath(),
        ),
        isReadonly: this.host.isReadonly(),
      })
    ) {
      return;
    }
    const viewport = this.host.getScopedGfxViewport();
    if (viewport instanceof HTMLElement) {
      // Pointer selection transfers keyboard ownership to the same scoped
      // workarea. Without this, the browser leaves focus on <body> after a
      // canvas click, so Escape, arrows and Delete cannot operate on the
      // selection the pointer just created.
      viewport.focus({ preventScroll: true });
    }
    const point = this.host.getScopedModelPointFromClient(
      event.clientX,
      event.clientY,
    );
    if (!point) return;
    const nodeId = this.host.findVisualNodeByClientPoint(
      event.clientX,
      event.clientY,
    );

    const pendingShape = this.host.getPendingVisualInsertShape();
    if (pendingShape && !nodeId) {
      this._claimViewportEvent(event);
      this._skipNextClickSelection = true;
      const insertedNodeId = this.host.insertPendingVisualNode(
        point,
        pendingShape,
      );
      if (insertedNodeId) {
        this.host.setVisualInspectorSuppressed(false);
        this.host.selectVisualNode(insertedNodeId);
      }
      return;
    }

    // A repeated down belongs to direct editing, not a second structural drag.
    // Families still own the first down in place of generic free-XY movement.
    if (nodeId && !repeat && this.host.consumeNodeDragStart?.(event)) {
      this._skipNextClickSelection = true;
      return;
    }

    if (this.host.consumeObjectIntent?.(event, repeat ? "edit" : "pointer")) {
      if (repeat && this._lastObjectPointerDown)
        this._lastObjectPointerDown.edited = true;
      // Native GFX detects double-clicks on pointer-up. Consume that paired
      // event too, before its generic text editor can steal a typed draft.
      this._claimViewportEvent(event);
      this._objectPointerId = event.pointerId;
      window.addEventListener("pointerup", this._handleObjectPointerUp, true);
      window.addEventListener(
        "pointercancel",
        this._handleObjectPointerUp,
        true,
      );
      this._skipNextClickSelection = true;
      return;
    }
    const intent = this._resolveSelectionIntent(event, point);
    this._rememberViewportPointerTarget(event, intent, point);
    if (intent.kind === "node") {
      this._claimViewportEvent(event);
      this.host.setVisualNodePointerSessionActive(true);
      const additive = hasMermaidNodeSelectionToggleModifier(event);
      this.host.setVisualInspectorSuppressed(additive);
      this.host.setVisualContextMenu(null);
      if (additive) {
        const selectionResolved = this.host.selectVisualNode(
          intent.nodeId,
          true,
        );
        if (
          !selectionResolved ||
          !this.host.getSelectedVisualNodeOrder().includes(intent.nodeId)
        ) {
          this.host.setVisualNodePointerSessionActive(false);
          return;
        }
      }
      this._dragNodeId = intent.nodeId;
      this._duplicateNodeDrag = event.altKey;
      this._didDragNode = false;
      this._dragLastPoint = { x: event.clientX, y: event.clientY };
      this._dragClientPoint = { x: event.clientX, y: event.clientY };
      this._dragViewportSnapshot = this.host.captureViewport();
      this._dragPointerId = Number.isFinite(event.pointerId)
        ? event.pointerId
        : null;
      // The nested GFX surface may transfer or release native pointer capture
      // during an ordinary drag. Window capture owns move/up delivery, while
      // only pointercancel (not lostpointercapture) cancels the gesture.
      window.addEventListener("pointermove", this._handleNodeDrag, true);
      window.addEventListener("pointerup", this._handleNodeDragEnd, true);
      window.addEventListener("pointercancel", this._handleNodeDragEnd, true);
      window.addEventListener("keydown", this._handleNodeDragKeydown, true);
      return;
    }

    if (intent.kind === "edge") {
      this._claimViewportEvent(event);
      this.host.setVisualContextMenu(null);
      this.host.selectVisualEdge(intent.edgeId);
      this._stabilizeVisualEdgeSelection(intent.edgeId);
      return;
    }
    if (intent.kind === "subgraph") {
      this._claimViewportEvent(event);
      this.host.setVisualContextMenu(null);
      this.host.selectVisualSubgraph(intent.subgraphId);
      return;
    }

    this.host.setVisualContextMenu(null);
  }

  handleViewportDoubleClick(event: MouseEvent) {
    if (!this._isScopedViewportEvent(event)) return;
    if (this.host.getPageSelectionTool() === "box") return;
    const pointer = this._lastObjectPointerDown;
    // Browsers emit dblclick after the repeated pointer activation. That down
    // already opened the family's draft before native GFX pointer-up editing.
    if (
      pointer?.edited &&
      this._eventTimestamp(event) - pointer.time < 500 &&
      Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) < 8
    ) {
      this._lastObjectPointerDown = null;
      this._claimViewportEvent(event);
      return;
    }
    if (
      shouldIgnoreMermaidGfxViewportDoubleClick({
        isButtonTarget:
          isMermaidGfxButtonTarget(event.target) &&
          !isSubgraphMoveHandle(event.target),
        isEditableTarget: this.host.isEditableEventTarget(event),
        isNativeControl: isMermaidGfxNativeControlEventPath(
          event.composedPath(),
        ),
        isReadonly: this.host.isReadonly(),
      })
    ) {
      return;
    }

    const point = this.host.getScopedModelPointFromClient(
      event.clientX,
      event.clientY,
    );
    if (!point) return;

    if (this.host.consumeObjectIntent?.(event, "edit")) {
      this._claimViewportEvent(event);
      return;
    }
    if (isSubgraphMoveHandle(event.target)) return;

    const recentPointerTarget = this._getRecentViewportPointerTarget(event);
    if (recentPointerTarget?.edgeId) {
      this.host.startInlineEdgeTextEdit(
        event,
        recentPointerTarget.edgeId,
        recentPointerTarget.point,
      );
      return;
    }
    if (recentPointerTarget?.subgraphId) {
      this.host.startInlineSubgraphTextEdit(
        event,
        recentPointerTarget.subgraphId,
      );
      return;
    }

    const hitNodeModel = this.host.findVisualNodeModelByClientPoint(
      event.clientX,
      event.clientY,
    );
    // A first click can materialize selection chrome between the two native
    // events of a double-click. Resolve the semantic id from the same hit-model
    // snapshot that will be edited; a second hit test can otherwise target an
    // overlapping State start marker while passing the visible State model.
    const hitNodeId = getMermaidGfxSelectionIdentity(hitNodeModel).nodeId;
    const nodeId =
      recentPointerTarget?.nodeId ||
      hitNodeId ||
      this.host.findVisualNodeByClientPoint(event.clientX, event.clientY) ||
      "";
    if (nodeId) {
      this.host.startInlineNodeTextEdit(
        event,
        nodeId,
        recentPointerTarget?.nodeId ? recentPointerTarget.model : hitNodeModel,
      );
      return;
    }

    const edgeId =
      this.host.findVisualEdgeByModelPoint(point.x, point.y) ||
      recentPointerTarget?.edgeId ||
      this.host.getSelectedVisualEdgeId() ||
      "";
    if (edgeId) {
      this.host.startInlineEdgeTextEdit(
        event,
        edgeId,
        recentPointerTarget?.edgeId ? recentPointerTarget.point : point,
      );
    }
  }

  private _eventTimestamp(event: Event) {
    return typeof event.timeStamp === "number" &&
      Number.isFinite(event.timeStamp)
      ? event.timeStamp
      : performance.now();
  }

  private _claimViewportEvent(event: Event) {
    event.preventDefault();
    event.stopPropagation();
    // The page-mode Mermaid editor installs capture listeners on document,
    // window and nested GFX hosts. Native GFX also listens during capture; once
    // Mermaid has resolved a node/edge/subgraph hit, prevent later listeners on
    // the same target from overwriting that semantic selection.
    event.stopImmediatePropagation();
  }

  private _stabilizeVisualEdgeSelection(edgeId: string) {
    // Document/window capture sees scoped GFX events before the nested editor
    // hosts. A native GFX target listener may still select an endpoint shape
    // later in the same event chain; reassert only explicit Mermaid edge hits
    // after that native pass so dense connectors remain selectable.
    const reselect = () => {
      if (this.host.getSelectedVisualEdgeId() !== edgeId) {
        this.host.selectVisualEdge(edgeId);
      }
    };
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(reselect);
      return;
    }
    setTimeout(reselect, 0);
  }

  private _getRecentViewportPointerTarget(event: MouseEvent | PointerEvent) {
    const target = this._lastViewportPointerTarget;
    if (!target) return null;
    const timestamp = this._eventTimestamp(event);
    if (timestamp - target.timestamp > 750) return null;
    if (Math.abs(event.clientX - target.clientX) > 8) return null;
    if (Math.abs(event.clientY - target.clientY) > 8) return null;
    return target;
  }

  private _rememberViewportPointerTarget(
    event: PointerEvent,
    intent: MermaidGfxViewportSelectionIntent,
    point: MermaidGfxViewportInteractionPoint,
  ) {
    if (intent.kind === "node") {
      const recentTarget = this._getRecentViewportPointerTarget(event);
      if (
        recentTarget?.nodeId &&
        recentTarget.nodeId !== intent.nodeId &&
        this.host.getSelectedVisualNodeId() === recentTarget.nodeId
      ) {
        // The first pointerdown of a double-click selects the intended node.
        // Selection chrome can then change the second hit to an overlapping
        // helper shape at the same screen point; keep the original target.
        return;
      }
      this._lastViewportPointerTarget = {
        clientX: event.clientX,
        clientY: event.clientY,
        model: this.host.findVisualNodeModelByClientPoint(
          event.clientX,
          event.clientY,
        ),
        nodeId: intent.nodeId,
        point,
        timestamp: this._eventTimestamp(event),
      };
      return;
    }
    if (intent.kind === "edge") {
      this._lastViewportPointerTarget = {
        clientX: event.clientX,
        clientY: event.clientY,
        edgeId: intent.edgeId,
        point,
        timestamp: this._eventTimestamp(event),
      };
      return;
    }
    if (intent.kind === "subgraph") {
      this._lastViewportPointerTarget = {
        clientX: event.clientX,
        clientY: event.clientY,
        point,
        subgraphId: intent.subgraphId,
        timestamp: this._eventTimestamp(event),
      };
      return;
    }
    if (this._getRecentViewportPointerTarget(event)) return;
    this._lastViewportPointerTarget = null;
  }

  private _isScopedViewportEvent(event: MouseEvent | PointerEvent) {
    if (!this.host.canConsumeViewportEvent()) return false;
    const viewport = this.host.getScopedGfxViewport();
    if (!(viewport instanceof Element)) return false;
    const path = event.composedPath();
    if (path.includes(viewport)) {
      // Window capture runs before the embedded block's pointer listener.
      // Activate its inner edit selection before consuming that same gesture.
      this.host.activateScopedEditor?.();
      return true;
    }
    // Mantine overlays are portalled to the document. They may visually overlap
    // the canvas, but their clicks still belong to the Facade control and must
    // never enter the viewport's coordinate-based fallback hit testing.
    if (isMermaidGfxInterfaceControlEventPath(path)) return false;
    if (!(viewport instanceof HTMLElement)) return false;

    const rect = viewport.getBoundingClientRect();
    const inside =
      event.clientX >= rect.left &&
      event.clientX <= rect.right &&
      event.clientY >= rect.top &&
      event.clientY <= rect.bottom;
    if (inside) this.host.activateScopedEditor?.();
    return inside;
  }

  private _resolveSelectionIntent(
    event: PointerEvent,
    point: MermaidGfxViewportInteractionPoint,
  ) {
    return resolveMermaidGfxViewportSelectionIntent({
      edgeId: this.host.findVisualEdgeByModelPoint(point.x, point.y),
      headerSubgraphId: this.host.findVisualSubgraphHeaderByModelPoint(
        point.x,
        point.y,
      ),
      nodeId: this.host.findVisualNodeByClientPoint(
        event.clientX,
        event.clientY,
      ),
      subgraphId: this.host.findVisualSubgraphByModelPoint(point.x, point.y),
    });
  }

  private readonly _handleNodeDrag = (event: PointerEvent) => {
    if (!this._isActiveDragPointer(event)) return;
    if (!this._dragNodeId || !this._dragLastPoint) return;
    event.preventDefault();
    this._dragClientPoint = { x: event.clientX, y: event.clientY };
    const drag = resolveMermaidGfxNodeDragDelta({
      lastPoint: this._dragLastPoint,
      nextPoint: { x: event.clientX, y: event.clientY },
    });
    if (!drag) return;
    this._dragLastPoint = drag.nextPoint;
    if (drag.shouldMove) {
      const modelDelta = this.host.getScopedModelDeltaFromClient(
        drag.dx,
        drag.dy,
      );
      if (modelDelta) {
        this._didDragNode = true;
        this.host.moveVisualNode(
          this._dragNodeId,
          modelDelta.dx,
          modelDelta.dy,
        );
      }
    }
    this._updateDragTarget(event.clientX, event.clientY);
    this._scheduleDragEdgePan();
  };

  private _updateDragTarget(clientX: number, clientY: number) {
    const point = this.host.getScopedModelPointFromClient(clientX, clientY);
    if (!point) return;
    this._dragTargetSubgraphId = this.host.findVisualSubgraphByModelPoint(
      point.x,
      point.y,
    );
    this.host.previewVisualNodeReparent(
      this._dragNodeId,
      this._dragTargetSubgraphId,
    );
  }

  private _scheduleDragEdgePan() {
    if (this._dragEdgePanRaf || !this._dragNodeId || !this._dragClientPoint) {
      return;
    }
    this._dragEdgePanRaf = requestAnimationFrame(this._runDragEdgePan);
  }

  private readonly _runDragEdgePan = (timestamp: number) => {
    this._dragEdgePanRaf = 0;
    const point = this._dragClientPoint;
    if (!point || !this._dragNodeId) return;
    const elapsedMs = this._dragEdgePanLastTimestamp
      ? Math.max(
          0,
          Math.min(
            MERMAID_DRAG_EDGE_PAN_MAX_FRAME_MS,
            timestamp - this._dragEdgePanLastTimestamp,
          ),
        )
      : 1000 / 60;
    this._dragEdgePanLastTimestamp = timestamp;
    const pan = this.host.panViewportNearClientPoint(
      point.x,
      point.y,
      (MERMAID_DRAG_EDGE_PAN_VIEW_SPEED_PX_PER_SECOND * elapsedMs) / 1000,
    );
    if (!pan) {
      this._dragEdgePanLastTimestamp = 0;
      return;
    }
    // Moving the camera alone would leave the dragged node behind. Apply the
    // same model delta so the node stays under the pointer while new canvas
    // space becomes reachable at every edge.
    this._didDragNode = true;
    this.host.moveVisualNode(this._dragNodeId, pan.dx, pan.dy);
    this._updateDragTarget(point.x, point.y);
    this._scheduleDragEdgePan();
  };

  private readonly _handleNodeDragEnd = (event: PointerEvent) => {
    if (!this._isActiveDragPointer(event)) return;
    const draggedNodeId = this._dragNodeId;
    const didDragNode = this._didDragNode;
    const targetSubgraphId = this._dragTargetSubgraphId;
    const duplicate = this._duplicateNodeDrag;
    const cancelled = event.type === "pointercancel";
    const viewportSnapshot = this._dragViewportSnapshot;
    this._stopVisualNodeDrag();
    if (cancelled) this.host.restoreViewport(viewportSnapshot);
    // Native browsers can still dispatch a click after a short drag. Only that
    // post-drag click is unsafe to replay as a selection; ordinary click
    // fallback must stay enabled for scoped GFX surfaces where pointerdown is
    // consumed by the nested editor before Mermaid selection stabilizes.
    if (didDragNode && !cancelled) this._skipNextClickSelection = true;
    if (
      didDragNode &&
      !cancelled &&
      !this.host.getSelectedVisualNodeOrder().includes(draggedNodeId)
    ) {
      // Projecting a previously unselected node during pointerdown can replace
      // native selection chrome and cancel that same browser gesture. A real
      // drag already has an authoritative semantic hit, so finalize selection
      // only after pointerup has safely reached this owner.
      this.host.selectVisualNode(draggedNodeId);
    }
    this.host.onVisualNodeDragEnd(
      draggedNodeId,
      didDragNode && !cancelled,
      targetSubgraphId,
      cancelled,
      duplicate,
    );
  };

  private readonly _handleNodeDragKeydown = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || !this.cancelVisualNodeDrag()) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  private _isActiveDragPointer(event: PointerEvent) {
    return (
      this._dragPointerId === null || event.pointerId === this._dragPointerId
    );
  }

  private _stopVisualNodeDrag() {
    if (this._dragEdgePanRaf) cancelAnimationFrame(this._dragEdgePanRaf);
    this._dragEdgePanRaf = 0;
    this._dragEdgePanLastTimestamp = 0;
    this._dragClientPoint = null;
    this._didDragNode = false;
    this._duplicateNodeDrag = false;
    this._dragNodeId = "";
    this._dragPointerId = null;
    this._dragTargetSubgraphId = "";
    this._dragLastPoint = null;
    this._dragViewportSnapshot = null;
    this.host.setVisualNodePointerSessionActive(false);
    this.host.previewVisualNodeReparent("", "");
    window.removeEventListener("pointermove", this._handleNodeDrag, true);
    window.removeEventListener("pointerup", this._handleNodeDragEnd, true);
    window.removeEventListener("pointercancel", this._handleNodeDragEnd, true);
    window.removeEventListener("keydown", this._handleNodeDragKeydown, true);
  }
}
