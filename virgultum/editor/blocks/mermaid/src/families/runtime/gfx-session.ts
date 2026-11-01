import { applyMermaidVisualModelCommand } from "../../commands/source-sync.js";
import { getMermaidBlockSource } from "../../utils.js";
import {
  usesTypeOwnedMermaidDocumentHistory,
  typeOwnedMermaidConnectionTargetsIncludeSubgraphs,
  typeOwnedMermaidNodeConnectionPorts,
} from "./gfx-owner-hooks.js";
import { reparentTypeOwnedMermaidGfxSubgraph } from "./gfx-graph-operations.js";
import {
  beginMermaidGeometryPreview,
  previewMermaidNodeSize,
  previewMermaidSubgraphBound,
  readMermaidGeometryPreview,
  releaseMermaidGeometryPreview,
  type MermaidGeometryPreview,
} from "./gfx-geometry-preview.js";
import type { MermaidBlockModel } from "@virgultum/model";
import type { BlockStdScope } from "@virgultum/std";
import { Bound } from "@virgultum/global/gfx";

import {
  addMermaidGfxEdgeCommand,
  applyMermaidGfxNodeCommand,
  applyMermaidGfxSubgraphCommand,
  reconnectMermaidGfxEdgeCommand,
} from "./gfx-commands.js";
import type { MermaidVisualModel, MermaidVisualEdge } from "./gfx-model.js";
import { allowsMermaidGfxSelfConnections } from "./gfx-graph-operations.js";
import {
  type MermaidGfxConnectionPreview,
  type MermaidGfxConnectionPortPoint,
  type MermaidGfxConnectionPreviewPoint,
  resolveMermaidGfxConnectionResultSelection,
  resolveMermaidGfxNodeConnection,
} from "../../mermaid-gfx-connection.js";
import {
  mermaidGfxMoveCoalesceKey,
  moveMermaidGfxBoundFromDrag,
} from "../../mermaid-gfx-move.js";
import type { MermaidRuntimeTransactionOptions } from "./transaction.js";
import { findNearestMermaidGfxNodeInDirection } from "../../mermaid-gfx-node-selection.js";
import {
  type MermaidGfxResizableModel,
  mermaidGfxResizeCoalesceKey,
  resizeMermaidGfxBoundFromDrag,
} from "../../mermaid-gfx-resize.js";
import {
  type MermaidGfxSelectionPatch,
  selectMermaidGfxEdgePatch,
  selectMermaidGfxNodePatch,
} from "../../mermaid-gfx-selection-state.js";
import {
  type MermaidGfxResizePointerStart,
  type MermaidGfxSubgraphMovePointerStart,
  type MermaidVisualViewportResizeStart,
  resolveMermaidGfxEdgeReconnectPointerStart,
  resolveMermaidGfxEdgeReconnectToTarget,
  resolveMermaidGfxKeyboardConnectionIntent,
  resolveMermaidGfxKeyboardEdgeReconnectIntent,
  resolveMermaidGfxKeyboardNodeConnection,
  resolveMermaidGfxKeyboardResize,
  resolveMermaidGfxKeyboardSubgraphMove,
  resolveMermaidGfxNodeConnectionPointerStart,
  resolveMermaidGfxNodeConnectionPointerUp,
  resolveMermaidGfxNodeConnectionPreview,
  resolveMermaidGfxResizePointerStart,
  resolveMermaidGfxSubgraphMovePointerStart,
  resolveMermaidVisualViewportResizeKeydown,
  resolveMermaidVisualViewportResizePointerMove,
  resolveMermaidVisualViewportResizePointerStart,
} from "./gfx-interaction.js";
import { mermaidMessages } from "../../i18n.js";

export type MermaidGfxSessionHost = {
  /** True consumes the gesture into a family-local draft, without history. */
  proposeConnection?: (
    proposal: import("./editor-capabilities.js").MermaidGfxConnectionProposal,
  ) => boolean;
  announceDiagnostic?(message: string): void;
  applyGfxMutation(
    run: () => boolean,
    options?: MermaidRuntimeTransactionOptions,
  ): boolean;
  applyVisualSelectionPatch(patch: MermaidGfxSelectionPatch): void;
  commitProjectionOwnerGeometry(): boolean;
  findVisualNodeByClientPoint(clientX: number, clientY: number): string;
  getMermaidVisualModelForEditing(): MermaidVisualModel | null;
  getModel(): MermaidBlockModel;
  getViewportIdentity?(): object | null;
  getPreviewElement?(id: string): unknown;
  getScopedModelPointFromClient(
    clientX: number,
    clientY: number,
  ): { x: number; y: number } | null;
  getScopedViewPointFromClient(
    clientX: number,
    clientY: number,
  ): MermaidGfxConnectionPreviewPoint | null;
  getSelectedVisualEdgeId(): string;
  getSelectedVisualEdgeHandles(): {
    source: MermaidGfxConnectionPreviewPoint;
    target: MermaidGfxConnectionPreviewPoint;
  } | null;
  getSelectedVisualNodeHandles(): ReadonlyArray<
    MermaidGfxConnectionPreviewPoint & {
      id: string;
      position: readonly [number, number];
    }
  >;
  getSelectedVisualNodeId(): string;
  getSelectedVisualSubgraphId(): string;
  getStd(): BlockStdScope;
  getViewportResizeStep(): number;
  getVisualNodeConnectionHandles(
    nodeId: string,
  ): readonly MermaidGfxConnectionPortPoint[];
  getVisualNodeGfxModel(nodeId: string): MermaidGfxResizableModel | null;
  getVisualSubgraphGfxModel(
    subgraphId: string,
  ): MermaidGfxResizableModel | null;
  isReadonly(): boolean;
  previewVisualSubgraphReparent(
    subgraphId: string,
    targetSubgraphId: string,
  ): void;
  reparentVisualSubgraph(
    subgraphId: string,
    parentId: string,
    coalesceKey: string,
  ): void;
  refreshRenderer?(): void;
  requestUpdate(): void;
  scheduleRender(): void;
  selectVisualEdge(edgeId: string): void;
  selectVisualSubgraph(subgraphId: string): void;
  setVisualViewportHeight(height: number): void;
  suppressNextViewportClickSelection(): void;
};

/**
 * Owns transient pointer/keyboard sessions for the shared page GFX editor.
 *
 * The host still owns DOM listener attachment, command history and render
 * lifecycle. Keeping the moving session state here prevents `mermaid-block.ts`
 * from growing family-specific connection, reconnect and resize branches
 * while preserving the existing command-based source/undo path. Model/std state
 * is read lazily through callbacks because block field initialization can run
 * before those BlockComponent accessors are usable.
 */
export class MermaidGfxSessionController {
  private connectVisualNodeSourceId = "";
  private connectVisualNodeSourceHandle: MermaidGfxConnectionPortPoint | null =
    null;
  private connectVisualNodePreview: MermaidGfxConnectionPreview | null = null;
  private isConnectingNodes = false;
  private reconnectVisualEdgeEndpoint: "source" | "target" | null = null;
  private reconnectVisualEdgeFixedNodeId = "";
  private reconnectVisualEdgeFixedPoint:
    MermaidGfxConnectionPreviewPoint | MermaidGfxConnectionPortPoint | null =
    null;
  private reconnectVisualEdgeId = "";
  private moveVisualSubgraphId = "";
  private moveVisualSubgraphTargetId: string | null = null;
  private moveVisualSubgraphStart:
    MermaidGfxSubgraphMovePointerStart["start"] | null = null;
  private resizeVisualNodeId = "";
  private resizeVisualNodeStart: MermaidGfxResizePointerStart["start"] | null =
    null;
  private resizeVisualSubgraphId = "";
  private resizeVisualSubgraphStart:
    MermaidGfxResizePointerStart["start"] | null = null;
  private geometryPreview: MermaidGeometryPreview | null = null;
  private resizeViewportStart: MermaidVisualViewportResizeStart | null = null;

  constructor(private readonly host: MermaidGfxSessionHost) {}

  private beginGeometryPreview() {
    const model = this.host.getMermaidVisualModelForEditing();
    if (!model || !usesTypeOwnedMermaidDocumentHistory(model.diagramType))
      return;
    this.geometryPreview = beginMermaidGeometryPreview(
      this.host.getModel(),
      model,
      this.host.getViewportIdentity?.() ?? undefined,
      this.host.getPreviewElement,
    );
    window.addEventListener("pointercancel", this.handleGeometryPointerCancel);
    window.addEventListener("keydown", this.handleGeometryEscape, true);
  }

  private readonly cancelGeometryPreview = () => {
    const preview = this.geometryPreview;
    this.geometryPreview = null;
    window.removeEventListener(
      "pointercancel",
      this.handleGeometryPointerCancel,
    );
    window.removeEventListener("keydown", this.handleGeometryEscape, true);
    if (preview) {
      releaseMermaidGeometryPreview(preview);
      this.host.refreshRenderer?.();
    }
  };

  private readonly handleGeometryPointerCancel = () =>
    this.stopTransientPointerInteractions();

  private readonly handleGeometryEscape = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || !this.geometryPreview) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    this.stopTransientPointerInteractions();
    this.host.requestUpdate();
  };

  private validateGeometryPreview() {
    if (
      !this.geometryPreview ||
      (!this.host.isReadonly() &&
        getMermaidBlockSource(this.host.getModel().props) ===
          this.geometryPreview.source &&
        this.geometryPreview.viewportIdentity ===
          (this.host.getViewportIdentity?.() ?? undefined))
    )
      return true;
    this.host.announceDiagnostic?.(
      mermaidMessages.visualMutationSourceRejected(
        this.geometryPreview.model.diagramType,
      ),
    );
    this.stopTransientPointerInteractions();
    return false;
  }

  private commitGeometryPreview(subgraphId?: string, parentId?: string | null) {
    const preview = this.geometryPreview;
    if (!preview) return false;
    let visual: MermaidVisualModel | null = readMermaidGeometryPreview(preview);
    this.cancelGeometryPreview();
    if (
      this.host.isReadonly() ||
      getMermaidBlockSource(this.host.getModel().props) !== preview.source ||
      preview.viewportIdentity !==
        (this.host.getViewportIdentity?.() ?? undefined)
    ) {
      this.host.announceDiagnostic?.(
        mermaidMessages.visualMutationSourceRejected(preview.model.diagramType),
      );
      return true;
    }
    const reparent =
      subgraphId &&
      parentId !== null &&
      parentId !== undefined &&
      visual?.subgraphs?.find((group) => group.id === subgraphId)?.parentId !==
        (parentId || undefined);
    if (reparent && visual)
      visual = reparentTypeOwnedMermaidGfxSubgraph(
        visual,
        subgraphId,
        parentId,
      );
    const committed = visual;
    if (committed)
      this.host.applyGfxMutation(
        () =>
          this.host.getStd().command.exec(applyMermaidVisualModelCommand, {
            model: this.host.getModel(),
            visualModel: committed,
            ...(!reparent
              ? {
                  sourceWrite: {
                    baseSource: preview.source,
                    source: preview.source,
                  },
                }
              : {}),
          })[1]?.applied === true,
      );
    this.host.scheduleRender();
    this.host.requestUpdate();
    return true;
  }

  get hasTransientGeometryPreview() {
    return this.geometryPreview !== null;
  }

  get connectionPreview() {
    return this.connectVisualNodePreview;
  }

  get isConnectingVisualNodes() {
    return this.isConnectingNodes;
  }

  get hasTransientConnectionPreview() {
    return this.isConnectingNodes || Boolean(this.reconnectVisualEdgeId);
  }

  startVisualNodeConnection() {
    const start = resolveMermaidGfxNodeConnectionPointerStart({
      isReadonly: this.host.isReadonly(),
      selectedEdgeId: this.host.getSelectedVisualEdgeId(),
      ...this.connectionSelection(),
    });
    if (!start) return false;
    this.stopVisualNodeConnection();
    this.connectVisualNodeSourceId = start.sourceNodeId;
    this.connectVisualNodeSourceHandle = null;
    this.isConnectingNodes = true;
    this.connectVisualNodePreview = null;
    window.addEventListener(
      "pointermove",
      this.handleVisualConnectorPointerMove,
    );
    this.host.requestUpdate();
    return true;
  }

  handleProjectionOwnerNodeSelection(
    targetNodeId: string,
    fallbackSourceNodeId: string,
  ) {
    const allowSelf = this.allowsSelfConnections();
    if (
      !this.isConnectingNodes ||
      !(this.connectVisualNodeSourceId || fallbackSourceNodeId) ||
      !targetNodeId ||
      (!allowSelf &&
        (this.connectVisualNodeSourceId || fallbackSourceNodeId) ===
          targetNodeId)
    ) {
      return false;
    }

    const sourceNodeId = this.connectVisualNodeSourceId || fallbackSourceNodeId;
    const connection = resolveMermaidGfxNodeConnection({
      allowSelf,
      isReadonly: this.host.isReadonly(),
      sourceNodeId,
      targetNodeId,
    });
    if (!connection) {
      this.stopVisualNodeConnection();
      return false;
    }
    const preview =
      this.connectVisualNodePreview?.validTarget &&
      this.connectVisualNodePreview.targetNodeId === targetNodeId
        ? this.connectVisualNodePreview
        : null;

    let edgeId = "";
    if (
      this.host.proposeConnection?.({
        ...connection,
        sourcePortId: preview?.sourcePortId,
        sourcePosition: preview?.sourcePosition,
        targetPortId: preview?.targetPortId,
        targetPosition: preview?.targetPosition,
      })
    ) {
      this.stopVisualNodeConnection();
      return true;
    }
    const applied = this.host.applyGfxMutation(() => {
      const [ok, result] = this.host
        .getStd()
        .command.exec(addMermaidGfxEdgeCommand, {
          model: this.host.getModel(),
          sourcePortId: preview?.sourcePortId,
          sourcePosition: preview?.sourcePosition,
          sourceNodeId: connection.sourceNodeId,
          targetPortId: preview?.targetPortId,
          targetPosition: preview?.targetPosition,
          targetNodeId: connection.targetNodeId,
        });
      edgeId = result?.edgeId ?? "";
      return ok;
    });
    if (!applied) return true;
    this.stopVisualNodeConnection();
    this.applyVisualConnectionResultSelection(edgeId);
    return true;
  }

  handleVisualConnectorHandlePointerDown = (
    event: PointerEvent,
    portId: string,
  ) => {
    const start = resolveMermaidGfxNodeConnectionPointerStart({
      isReadonly: this.host.isReadonly(),
      selectedEdgeId: this.host.getSelectedVisualEdgeId(),
      ...this.connectionSelection(),
    });
    if (!start) return;
    event.preventDefault();
    event.stopPropagation();
    this.stopVisualNodeConnection();
    this.connectVisualNodeSourceId = start.sourceNodeId;
    this.connectVisualNodeSourceHandle =
      this.host
        .getSelectedVisualNodeHandles()
        .find((handle) => handle.id === portId) ?? null;
    if (!this.connectVisualNodeSourceHandle) {
      this.stopVisualNodeConnection();
      return;
    }
    this.isConnectingNodes = true;
    this.updateVisualNodeConnectionPreview(event.clientX, event.clientY);
    window.addEventListener(
      "pointermove",
      this.handleVisualConnectorPointerMove,
    );
    window.addEventListener("pointerup", this.handleVisualConnectorPointerUp);
  };

  handleVisualConnectorHandleKeydown = (
    event: KeyboardEvent,
    portId: string,
  ) => {
    const intent = resolveMermaidGfxKeyboardConnectionIntent({
      isReadonly: this.host.isReadonly(),
      key: event.key,
      selectedEdgeId: this.host.getSelectedVisualEdgeId(),
      ...this.connectionSelection(),
    });
    if (!intent) return;
    if (
      !this.host
        .getSelectedVisualNodeHandles()
        .some((handle) => handle.id === portId)
    ) {
      return;
    }
    const targetNodeId = this.findNearestVisualNodeInDirection(
      intent.sourceNodeId,
      intent.direction,
    );
    if (!targetNodeId) {
      this.host.announceDiagnostic?.(
        mermaidMessages.visualConnectionInvalidTarget(),
      );
      return;
    }
    const connection = resolveMermaidGfxKeyboardNodeConnection({
      isReadonly: this.host.isReadonly(),
      sourceNodeId: intent.sourceNodeId,
      targetNodeId,
    });
    if (!connection) {
      this.host.announceDiagnostic?.(
        mermaidMessages.visualConnectionInvalidTarget(),
      );
      return;
    }
    const sourceHandle = this.host
      .getSelectedVisualNodeHandles()
      .find((handle) => handle.id === portId);
    if (!sourceHandle) return;
    const targetHandle = this.nearestConnectionHandle(
      targetNodeId,
      sourceHandle,
    );
    event.preventDefault();
    event.stopPropagation();
    let edgeId = "";
    if (
      this.host.proposeConnection?.({
        ...connection,
        sourcePortId: sourceHandle.id,
        sourcePosition: sourceHandle.position,
        targetPortId: targetHandle?.id,
        targetPosition: targetHandle?.position,
      })
    )
      return;
    const applied = this.host.applyGfxMutation(() => {
      const [ok, result] = this.host
        .getStd()
        .command.exec(addMermaidGfxEdgeCommand, {
          model: this.host.getModel(),
          sourcePortId: sourceHandle.id,
          sourcePosition: sourceHandle.position,
          sourceNodeId: connection.sourceNodeId,
          targetPortId: targetHandle?.id,
          targetPosition: targetHandle?.position,
          targetNodeId: connection.targetNodeId,
        });
      edgeId = result?.edgeId ?? "";
      return ok;
    });
    if (!applied) return;
    this.applyVisualConnectionResultSelection(edgeId);
  };

  handleVisualEdgeReconnectKeydown = (
    event: KeyboardEvent,
    endpoint: "source" | "target",
  ) => {
    const visualModel = this.host.getMermaidVisualModelForEditing();
    const edge = visualModel?.edges.find(
      (candidate) => candidate.id === this.host.getSelectedVisualEdgeId(),
    );
    const intent = resolveMermaidGfxKeyboardEdgeReconnectIntent({
      edge,
      endpoint,
      isReadonly: this.host.isReadonly(),
      key: event.key,
    });
    if (!intent) return;
    const nodeId = this.findNearestVisualNodeInDirection(
      intent.movingNodeId,
      intent.direction,
      new Set([intent.fixedNodeId]),
    );
    if (!nodeId) {
      this.host.announceDiagnostic?.(
        mermaidMessages.visualConnectionInvalidTarget(),
      );
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const reconnect = resolveMermaidGfxEdgeReconnectToTarget({
      edgeId: intent.edgeId,
      endpoint: intent.endpoint,
      isReadonly: this.host.isReadonly(),
      targetNodeId: nodeId,
    });
    if (!reconnect) {
      this.host.announceDiagnostic?.(
        mermaidMessages.visualConnectionInvalidTarget(),
      );
      return;
    }
    const handles = this.host.getSelectedVisualEdgeHandles();
    const fixedHandle =
      endpoint === "source" ? handles?.target : handles?.source;
    const targetHandle = fixedHandle
      ? this.nearestConnectionHandle(nodeId, fixedHandle)
      : null;
    if (edge && this.proposeEdgeReconnect(edge, endpoint, nodeId, targetHandle))
      return;
    const applied = this.host.applyGfxMutation(
      () =>
        this.host.getStd().command.exec(reconnectMermaidGfxEdgeCommand, {
          edgeId: reconnect.edgeId,
          endpoint: reconnect.endpoint,
          model: this.host.getModel(),
          nodeId: reconnect.targetNodeId,
          portId: targetHandle?.id,
          position: targetHandle?.position,
        })[0],
    );
    if (!applied) return;
    this.host.applyVisualSelectionPatch(
      selectMermaidGfxEdgePatch(reconnect.edgeId),
    );
    this.host.requestUpdate();
  };

  handleVisualEdgeReconnectPointerDown(
    event: PointerEvent,
    endpoint: "source" | "target",
  ) {
    const start = resolveMermaidGfxEdgeReconnectPointerStart({
      edgeId: this.host.getSelectedVisualEdgeId(),
      endpoint,
      isReadonly: this.host.isReadonly(),
    });
    if (!start) return;
    const edge = this.host
      .getMermaidVisualModelForEditing()
      ?.edges.find((candidate) => candidate.id === start.edgeId);
    const handles = this.host.getSelectedVisualEdgeHandles();
    if (!edge || !handles) return;
    event.preventDefault();
    event.stopPropagation();
    this.stopVisualEdgeReconnect();
    this.reconnectVisualEdgeEndpoint = start.endpoint;
    this.reconnectVisualEdgeFixedNodeId =
      start.endpoint === "source" ? edge.target : edge.source;
    const fixedPoint =
      start.endpoint === "source" ? handles.target : handles.source;
    const fixedPortId =
      start.endpoint === "source" ? edge.targetPortId : edge.sourcePortId;
    const fixedPosition =
      start.endpoint === "source" ? edge.targetPosition : edge.sourcePosition;
    this.reconnectVisualEdgeFixedPoint =
      fixedPortId && fixedPosition
        ? { ...fixedPoint, id: fixedPortId, position: fixedPosition }
        : fixedPoint;
    this.reconnectVisualEdgeId = start.edgeId;
    this.updateVisualEdgeReconnectPreview(event.clientX, event.clientY);
    window.addEventListener(
      "pointermove",
      this.handleVisualEdgeReconnectPointerMove,
    );
    window.addEventListener(
      "pointerup",
      this.handleVisualEdgeReconnectPointerUp,
    );
  }

  handleVisualGfxResizeHandleKeydown = (
    event: KeyboardEvent,
    kind: "node" | "subgraph",
  ) => {
    const resize = resolveMermaidGfxKeyboardResize({
      isReadonly: this.host.isReadonly(),
      key: event.key,
      kind,
      nodeId: this.host.getSelectedVisualNodeId(),
      nodeModel: this.host.getVisualNodeGfxModel(
        this.host.getSelectedVisualNodeId(),
      ),
      shiftKey: event.shiftKey,
      subgraphId: this.host.getSelectedVisualSubgraphId(),
      subgraphModel: this.host.getVisualSubgraphGfxModel(
        this.host.getSelectedVisualSubgraphId(),
      ),
    });
    if (!resize) return;
    event.preventDefault();
    event.stopPropagation();
    const applied = this.host.applyGfxMutation(() => {
      if (resize.target.kind === "node") {
        return this.host.getStd().command.exec(applyMermaidGfxNodeCommand, {
          height: resize.height,
          model: this.host.getModel(),
          nodeId: resize.target.id,
          width: resize.width,
        })[0];
      }
      return this.host.getStd().command.exec(applyMermaidGfxSubgraphCommand, {
        height: resize.height,
        model: this.host.getModel(),
        subgraphId: resize.target.id,
        width: resize.width,
      })[0];
    });
    if (!applied) return;
    this.host.requestUpdate();
  };

  handleVisualGfxResizeHandlePointerDown = (
    event: PointerEvent,
    kind: "node" | "subgraph",
  ) => {
    const start = resolveMermaidGfxResizePointerStart({
      isReadonly: this.host.isReadonly(),
      kind,
      nodeId: this.host.getSelectedVisualNodeId(),
      nodeModel: this.host.getVisualNodeGfxModel(
        this.host.getSelectedVisualNodeId(),
      ),
      pointer: this.host.getScopedModelPointFromClient(
        event.clientX,
        event.clientY,
      ),
      subgraphId: this.host.getSelectedVisualSubgraphId(),
      subgraphModel: this.host.getVisualSubgraphGfxModel(
        this.host.getSelectedVisualSubgraphId(),
      ),
    });
    if (!start) return;

    event.preventDefault();
    event.stopPropagation();
    this.stopVisualGfxSubgraphMove();
    if (start.target.kind === "node") {
      this.resizeVisualNodeId = start.target.id;
      this.resizeVisualNodeStart = start.start;
      this.beginGeometryPreview();
      window.addEventListener("pointermove", this.handleVisualGfxNodeResize);
      window.addEventListener("pointerup", this.handleVisualGfxNodeResizeEnd);
    } else {
      this.resizeVisualSubgraphId = start.target.id;
      this.resizeVisualSubgraphStart = start.start;
      this.beginGeometryPreview();
      window.addEventListener(
        "pointermove",
        this.handleVisualGfxSubgraphResize,
      );
      window.addEventListener(
        "pointerup",
        this.handleVisualGfxSubgraphResizeEnd,
      );
    }
  };

  handleVisualGfxSubgraphMoveHandleKeydown = (event: KeyboardEvent) => {
    const move = resolveMermaidGfxKeyboardSubgraphMove({
      isReadonly: this.host.isReadonly(),
      key: event.key,
      shiftKey: event.shiftKey,
      subgraphId: this.host.getSelectedVisualSubgraphId(),
      subgraphModel: this.host.getVisualSubgraphGfxModel(
        this.host.getSelectedVisualSubgraphId(),
      ),
    });
    if (!move) return;
    event.preventDefault();
    event.stopPropagation();
    const applied = this.host.applyGfxMutation(() =>
      this.moveSubgraphToSurfacePosition(move.target.id, move.x, move.y),
    );
    if (!applied) return;
    this.host.requestUpdate();
  };

  handleVisualGfxSubgraphMoveHandlePointerDown = (event: PointerEvent) => {
    const start = resolveMermaidGfxSubgraphMovePointerStart({
      isReadonly: this.host.isReadonly(),
      pointer: this.host.getScopedModelPointFromClient(
        event.clientX,
        event.clientY,
      ),
      subgraphId: this.host.getSelectedVisualSubgraphId(),
      subgraphModel: this.host.getVisualSubgraphGfxModel(
        this.host.getSelectedVisualSubgraphId(),
      ),
    });
    if (!start) return;
    event.preventDefault();
    event.stopPropagation();
    this.stopVisualGfxNodeResize();
    this.stopVisualGfxSubgraphResize();
    this.moveVisualSubgraphId = start.target.id;
    this.moveVisualSubgraphStart = start.start;
    this.beginGeometryPreview();
    window.addEventListener("pointermove", this.handleVisualGfxSubgraphMove);
    window.addEventListener("pointerup", this.handleVisualGfxSubgraphMoveEnd);
  };

  handleVisualViewportResizeKeydown = (
    event: KeyboardEvent,
    currentHeight: number,
  ) => {
    const nextHeight = resolveMermaidVisualViewportResizeKeydown({
      currentHeight,
      isReadonly: this.host.isReadonly(),
      key: event.key,
      shiftKey: event.shiftKey,
      step: this.host.getViewportResizeStep(),
    });
    if (nextHeight === null) return;
    event.preventDefault();
    event.stopPropagation();
    this.host.setVisualViewportHeight(nextHeight);
  };

  handleVisualViewportResizePointerDown(
    event: PointerEvent,
    currentHeight: number,
  ) {
    const start = resolveMermaidVisualViewportResizePointerStart({
      currentHeight,
      isReadonly: this.host.isReadonly(),
      pointerClientY: event.clientY,
    });
    if (!start) return;
    event.preventDefault();
    event.stopPropagation();
    this.resizeViewportStart = start;
    window.addEventListener(
      "pointermove",
      this.handleVisualViewportResizePointerMove,
    );
    window.addEventListener(
      "pointerup",
      this.handleVisualViewportResizePointerUp,
    );
  }

  stopTransientPointerInteractions() {
    this.stopMermaidVisualViewportResize();
    this.stopVisualGfxSubgraphMove();
    this.stopVisualGfxNodeResize();
    this.stopVisualGfxSubgraphResize();
    this.stopVisualNodeConnection();
    this.stopVisualEdgeReconnect();
  }

  stopVisualNodeConnection() {
    this.connectVisualNodeSourceId = "";
    this.connectVisualNodeSourceHandle = null;
    this.connectVisualNodePreview = null;
    this.isConnectingNodes = false;
    window.removeEventListener(
      "pointermove",
      this.handleVisualConnectorPointerMove,
    );
    window.removeEventListener(
      "pointerup",
      this.handleVisualConnectorPointerUp,
    );
    this.host.requestUpdate();
  }

  private readonly handleVisualConnectorPointerMove = (event: PointerEvent) => {
    if (!this.connectVisualNodeSourceId) return;
    event.preventDefault();
    this.updateVisualNodeConnectionPreview(event.clientX, event.clientY);
  };

  private readonly handleVisualConnectorPointerUp = (event: PointerEvent) => {
    const sourceNodeId = this.connectVisualNodeSourceId;
    const preview = this.connectVisualNodePreview;
    this.stopVisualNodeConnection();
    const connection = resolveMermaidGfxNodeConnectionPointerUp({
      allowSelf: this.allowsSelfConnections(),
      hitTargetNodeId: this.host.findVisualNodeByClientPoint(
        event.clientX,
        event.clientY,
      ),
      isReadonly: this.host.isReadonly(),
      preview,
      sourceNodeId,
    });
    if (!connection) return;
    if (this.host.proposeConnection?.(connection)) return;
    let edgeId = "";
    const applied = this.host.applyGfxMutation(() => {
      const [ok, result] = this.host
        .getStd()
        .command.exec(addMermaidGfxEdgeCommand, {
          model: this.host.getModel(),
          sourcePortId: connection.sourcePortId,
          sourcePosition: connection.sourcePosition,
          sourceNodeId: connection.sourceNodeId,
          targetPortId: connection.targetPortId,
          targetPosition: connection.targetPosition,
          targetNodeId: connection.targetNodeId,
        });
      edgeId = result?.edgeId ?? "";
      return ok;
    });
    if (!applied) return;
    this.applyVisualConnectionResultSelection(edgeId);
  };

  private readonly handleVisualGfxNodeResize = (event: PointerEvent) => {
    if (!this.validateGeometryPreview()) return;
    if (!this.resizeVisualNodeId || !this.resizeVisualNodeStart) return;
    event.preventDefault();
    const pointer = this.host.getScopedModelPointFromClient(
      event.clientX,
      event.clientY,
    );
    if (!pointer) return;
    const { height, width } = resizeMermaidGfxBoundFromDrag({
      pointer,
      start: this.resizeVisualNodeStart,
    });
    if (this.geometryPreview) {
      previewMermaidNodeSize(
        this.geometryPreview,
        this.resizeVisualNodeId,
        width,
        height,
      );
      this.host.refreshRenderer?.();
      this.host.requestUpdate();
      return;
    }
    this.host.applyGfxMutation(
      () =>
        this.host.getStd().command.exec(applyMermaidGfxNodeCommand, {
          height,
          model: this.host.getModel(),
          nodeId: this.resizeVisualNodeId,
          projectionOnly: true,
          width,
        })[0],
      {
        coalesceKey: mermaidGfxResizeCoalesceKey({
          id: this.resizeVisualNodeId,
          kind: "node",
        }),
        deferUpdate: true,
      },
    );
    this.host.requestUpdate();
  };

  private readonly handleVisualGfxNodeResizeEnd = () => {
    if (this.commitGeometryPreview()) {
      this.stopVisualGfxNodeResize();
      return;
    }
    this.stopVisualGfxNodeResize();
    this.host.commitProjectionOwnerGeometry();
    this.host.scheduleRender();
    this.host.requestUpdate();
  };

  private readonly handleVisualGfxSubgraphMove = (event: PointerEvent) => {
    if (!this.validateGeometryPreview()) return;
    if (!this.moveVisualSubgraphId || !this.moveVisualSubgraphStart) return;
    event.preventDefault();
    const pointer = this.host.getScopedModelPointFromClient(
      event.clientX,
      event.clientY,
    );
    if (!pointer) return;
    const { x, y } = moveMermaidGfxBoundFromDrag({
      pointer,
      start: this.moveVisualSubgraphStart,
    });
    if (this.geometryPreview) {
      previewMermaidSubgraphBound(
        this.geometryPreview,
        this.moveVisualSubgraphId,
        { x, y },
      );
      this.host.refreshRenderer?.();
    } else
      this.host.applyGfxMutation(
        () =>
          this.moveSubgraphToSurfacePosition(
            this.moveVisualSubgraphId,
            x,
            y,
            true,
          ),
        {
          coalesceKey: mermaidGfxMoveCoalesceKey({
            id: this.moveVisualSubgraphId,
            kind: "subgraph",
          }),
          deferUpdate: true,
        },
      );
    this.host.requestUpdate();
    const visualModel = this.host.getMermaidVisualModelForEditing();
    const descendants = new Set<string>();
    const visit = (parentId: string) => {
      for (const subgraph of visualModel?.subgraphs ?? []) {
        if (subgraph.parentId !== parentId || descendants.has(subgraph.id)) {
          continue;
        }
        descendants.add(subgraph.id);
        visit(subgraph.id);
      }
    };
    visit(this.moveVisualSubgraphId);
    this.moveVisualSubgraphTargetId =
      (visualModel?.subgraphs ?? [])
        .flatMap((subgraph) => {
          if (
            subgraph.id === this.moveVisualSubgraphId ||
            descendants.has(subgraph.id)
          ) {
            return [];
          }
          const element = this.host.getVisualSubgraphGfxModel(subgraph.id);
          if (!element?.xywh) return [];
          const bound = Bound.deserialize(element.xywh);
          return bound.containsPoint([pointer.x, pointer.y])
            ? [{ id: subgraph.id, area: bound.w * bound.h }]
            : [];
        })
        .sort((left, right) => left.area - right.area)[0]?.id ?? "";
    this.host.previewVisualSubgraphReparent(
      this.moveVisualSubgraphId,
      this.moveVisualSubgraphTargetId,
    );
  };

  private moveSubgraphToSurfacePosition(
    subgraphId: string,
    x: number,
    y: number,
    projectionOnly = false,
  ) {
    const element = this.host.getVisualSubgraphGfxModel(subgraphId);
    const subgraph = this.host
      .getMermaidVisualModelForEditing()
      ?.subgraphs?.find((candidate) => candidate.id === subgraphId);
    if (!element?.xywh || !subgraph) return false;
    const bound = Bound.deserialize(element.xywh);
    // Pointer and keyboard targets are absolute Surface coordinates; the
    // semantic command consumes owner-relative coordinates. Resolve their
    // offset for every update because moving a group can move the owner origin.
    return this.host.getStd().command.exec(applyMermaidGfxSubgraphCommand, {
      model: this.host.getModel(),
      moveMembers: true,
      projectionOnly,
      subgraphId,
      x: subgraph.x + x - bound.x,
      y: subgraph.y + y - bound.y,
    })[0];
  }

  private readonly handleVisualGfxSubgraphMoveEnd = () => {
    const subgraphId = this.moveVisualSubgraphId;
    const parentId = this.moveVisualSubgraphTargetId;
    if (this.commitGeometryPreview(subgraphId, parentId)) {
      this.stopVisualGfxSubgraphMove();
      this.host.suppressNextViewportClickSelection();
      this.host.selectVisualSubgraph(subgraphId);
      return;
    }
    this.stopVisualGfxSubgraphMove();
    if (subgraphId && parentId !== null) {
      this.host.reparentVisualSubgraph(
        subgraphId,
        parentId,
        mermaidGfxMoveCoalesceKey({ id: subgraphId, kind: "subgraph" }),
      );
      this.host.suppressNextViewportClickSelection();
      this.host.selectVisualSubgraph(subgraphId);
    }
    if (subgraphId) this.host.commitProjectionOwnerGeometry();
    this.host.scheduleRender();
    this.host.requestUpdate();
  };

  private readonly handleVisualGfxSubgraphResize = (event: PointerEvent) => {
    if (!this.validateGeometryPreview()) return;
    if (!this.resizeVisualSubgraphId || !this.resizeVisualSubgraphStart) {
      return;
    }
    event.preventDefault();
    const pointer = this.host.getScopedModelPointFromClient(
      event.clientX,
      event.clientY,
    );
    if (!pointer) return;
    const { height, width } = resizeMermaidGfxBoundFromDrag({
      pointer,
      start: this.resizeVisualSubgraphStart,
    });
    if (this.geometryPreview) {
      previewMermaidSubgraphBound(
        this.geometryPreview,
        this.resizeVisualSubgraphId,
        { width, height },
      );
      this.host.refreshRenderer?.();
      this.host.requestUpdate();
      return;
    }
    this.host.applyGfxMutation(
      () =>
        this.host.getStd().command.exec(applyMermaidGfxSubgraphCommand, {
          height,
          model: this.host.getModel(),
          projectionOnly: true,
          subgraphId: this.resizeVisualSubgraphId,
          width,
        })[0],
      {
        coalesceKey: mermaidGfxResizeCoalesceKey({
          id: this.resizeVisualSubgraphId,
          kind: "subgraph",
        }),
        deferUpdate: true,
      },
    );
    this.host.requestUpdate();
  };

  private readonly handleVisualGfxSubgraphResizeEnd = () => {
    const subgraphId = this.resizeVisualSubgraphId;
    if (this.commitGeometryPreview()) {
      this.stopVisualGfxSubgraphResize();
      this.host.suppressNextViewportClickSelection();
      this.host.selectVisualSubgraph(subgraphId);
      return;
    }
    this.stopVisualGfxSubgraphResize();
    if (subgraphId) this.host.commitProjectionOwnerGeometry();
    if (subgraphId) {
      this.host.suppressNextViewportClickSelection();
      this.host.selectVisualSubgraph(subgraphId);
    }
    this.host.scheduleRender();
    this.host.requestUpdate();
  };

  private readonly handleVisualViewportResizePointerMove = (
    event: PointerEvent,
  ) => {
    const nextHeight = resolveMermaidVisualViewportResizePointerMove({
      pointerClientY: event.clientY,
      start: this.resizeViewportStart,
    });
    if (nextHeight === null) return;
    event.preventDefault();
    this.host.setVisualViewportHeight(nextHeight);
  };

  private readonly handleVisualViewportResizePointerUp = () => {
    this.stopMermaidVisualViewportResize();
    this.host.requestUpdate();
  };

  private readonly handleVisualEdgeReconnectPointerUp = (
    upEvent: PointerEvent,
  ) => {
    const edgeId = this.reconnectVisualEdgeId;
    const edgeEndpoint = this.reconnectVisualEdgeEndpoint;
    this.stopVisualEdgeReconnect();
    if (!edgeId || !edgeEndpoint) return;
    // The release belongs to reconnect, including its following native click.
    // Keep the edge selected instead of letting that click select the target.
    this.host.suppressNextViewportClickSelection();

    const targetNodeId = this.host.findVisualNodeByClientPoint(
      upEvent.clientX,
      upEvent.clientY,
    );
    const reconnect = resolveMermaidGfxEdgeReconnectToTarget({
      edgeId,
      endpoint: edgeEndpoint,
      isReadonly: this.host.isReadonly(),
      targetNodeId,
    });
    if (!reconnect) return;
    const targetHandle = this.nearestConnectionHandle(
      targetNodeId,
      this.host.getScopedViewPointFromClient(upEvent.clientX, upEvent.clientY),
    );
    const edge = this.host
      .getMermaidVisualModelForEditing()
      ?.edges.find((edge) => edge.id === edgeId);
    if (
      edge &&
      this.proposeEdgeReconnect(edge, edgeEndpoint, targetNodeId, targetHandle)
    )
      return;
    const applied = this.host.applyGfxMutation(
      () =>
        this.host.getStd().command.exec(reconnectMermaidGfxEdgeCommand, {
          edgeId: reconnect.edgeId,
          endpoint: reconnect.endpoint,
          model: this.host.getModel(),
          nodeId: reconnect.targetNodeId,
          portId: targetHandle?.id,
          position: targetHandle?.position,
        })[0],
    );
    if (!applied) return;
    this.host.applyVisualSelectionPatch(selectMermaidGfxEdgePatch(edgeId));
    this.host.requestUpdate();
  };

  private readonly handleVisualEdgeReconnectPointerMove = (
    event: PointerEvent,
  ) => {
    if (!this.reconnectVisualEdgeId) return;
    event.preventDefault();
    this.updateVisualEdgeReconnectPreview(event.clientX, event.clientY);
  };

  private proposeEdgeReconnect(
    edge: MermaidVisualEdge,
    endpoint: "source" | "target",
    nodeId: string,
    handle: {
      id?: string;
      position?: MermaidVisualEdge["sourcePosition"];
    } | null,
  ) {
    const model = this.host.getMermaidVisualModelForEditing(),
      node = model?.nodes.find((node) => node.id === nodeId);
    // A neutral fallback handle is not an authored port identity. Only an
    // actual family port policy can make the dropped endpoint explicit.
    const explicit =
      model &&
      node &&
      typeOwnedMermaidNodeConnectionPorts(model, node)?.some(
        (port) => port.id === handle?.id,
      )
        ? handle
        : null;
    return (
      this.host.proposeConnection?.({
        edgeId: edge.id,
        endpoint,
        sourceNodeId: endpoint === "source" ? nodeId : edge.source,
        targetNodeId: endpoint === "target" ? nodeId : edge.target,
        sourcePortId: endpoint === "source" ? explicit?.id : edge.sourcePortId,
        sourcePosition:
          endpoint === "source" ? explicit?.position : edge.sourcePosition,
        targetPortId: endpoint === "target" ? explicit?.id : edge.targetPortId,
        targetPosition:
          endpoint === "target" ? explicit?.position : edge.targetPosition,
      }) ?? false
    );
  }

  private updateVisualEdgeReconnectPreview(clientX: number, clientY: number) {
    const fixedNodeId = this.reconnectVisualEdgeFixedNodeId;
    const fixedPoint = this.reconnectVisualEdgeFixedPoint;
    if (!fixedNodeId || !fixedPoint) return;
    const pointer = this.host.getScopedViewPointFromClient(clientX, clientY);
    const targetNodeId = this.host.findVisualNodeByClientPoint(
      clientX,
      clientY,
    );
    const targetHandle = this.nearestConnectionHandle(targetNodeId, pointer);
    this.connectVisualNodePreview = resolveMermaidGfxNodeConnectionPreview({
      allowSelf: this.allowsSelfConnections(),
      pointer,
      sourceHandle: fixedPoint,
      sourceNodeId: fixedNodeId,
      targetHandle,
      targetNodeId,
    });
    this.host.requestUpdate();
  }

  private updateVisualNodeConnectionPreview(clientX: number, clientY: number) {
    const sourceNodeId = this.connectVisualNodeSourceId;
    if (!sourceNodeId) {
      this.connectVisualNodePreview = null;
      this.host.requestUpdate();
      return;
    }

    const pointer = this.host.getScopedViewPointFromClient(clientX, clientY);
    const targetNodeId = this.host.findVisualNodeByClientPoint(
      clientX,
      clientY,
    );
    const targetHandle = this.nearestConnectionHandle(targetNodeId, pointer);
    const sourceHandle =
      this.connectVisualNodeSourceHandle ??
      this.nearestConnectionHandle(sourceNodeId, targetHandle ?? pointer);
    this.connectVisualNodePreview = resolveMermaidGfxNodeConnectionPreview({
      allowSelf: this.allowsSelfConnections(),
      pointer,
      sourceHandle,
      sourceNodeId,
      targetHandle,
      targetNodeId,
    });
    this.host.requestUpdate();
  }

  private applyVisualConnectionResultSelection(edgeId: string) {
    const selection = resolveMermaidGfxConnectionResultSelection({ edgeId });
    if (selection.kind === "edge") {
      this.host.selectVisualEdge(selection.edgeId);
      return;
    }
    this.host.applyVisualSelectionPatch(
      selectMermaidGfxNodePatch({
        nodeId: "",
        nodeOrder: [],
      }),
    );
    this.host.requestUpdate();
  }

  private nearestConnectionHandle(
    nodeId: string,
    reference: MermaidGfxConnectionPreviewPoint | null,
  ) {
    if (!nodeId || !reference) return null;
    return (
      this.host
        .getVisualNodeConnectionHandles(nodeId)
        .reduce<MermaidGfxConnectionPortPoint | null>((nearest, handle) => {
          if (!nearest) return handle;
          const distance =
            (handle.left - reference.left) ** 2 +
            (handle.top - reference.top) ** 2;
          const nearestDistance =
            (nearest.left - reference.left) ** 2 +
            (nearest.top - reference.top) ** 2;
          return distance < nearestDistance ? handle : nearest;
        }, null) ?? null
    );
  }

  private allowsSelfConnections() {
    const model = this.host.getMermaidVisualModelForEditing();
    return model ? allowsMermaidGfxSelfConnections(model) : false;
  }

  private connectionSelection() {
    const model = this.host.getMermaidVisualModelForEditing();
    const subgraphId = this.host.getSelectedVisualSubgraphId();
    return model &&
      subgraphId &&
      typeOwnedMermaidConnectionTargetsIncludeSubgraphs(model)
      ? { selectedNodeId: subgraphId, selectedSubgraphId: "" }
      : {
          selectedNodeId: this.host.getSelectedVisualNodeId(),
          selectedSubgraphId: subgraphId,
        };
  }

  private findNearestVisualNodeInDirection(
    fromNodeId: string,
    direction: Parameters<
      typeof findNearestMermaidGfxNodeInDirection
    >[0]["direction"],
    excludedNodeIds: ReadonlySet<string> = new Set(),
  ) {
    const visualModel = this.host.getMermaidVisualModelForEditing();
    if (!visualModel) return "";
    const subgraphs = typeOwnedMermaidConnectionTargetsIncludeSubgraphs(
      visualModel,
    )
      ? (visualModel.subgraphs ?? [])
      : [];
    return findNearestMermaidGfxNodeInDirection({
      direction,
      excludedNodeIds,
      fromNodeId,
      getNodeXywh: (nodeId) =>
        this.host.getVisualNodeGfxModel(nodeId)?.xywh ??
        (subgraphs.some((g) => g.id === nodeId)
          ? this.host.getVisualSubgraphGfxModel(nodeId)?.xywh
          : undefined),
      nodes: [...visualModel.nodes, ...subgraphs],
    });
  }

  private stopVisualGfxNodeResize() {
    this.cancelGeometryPreview();
    this.resizeVisualNodeId = "";
    this.resizeVisualNodeStart = null;
    window.removeEventListener("pointermove", this.handleVisualGfxNodeResize);
    window.removeEventListener("pointerup", this.handleVisualGfxNodeResizeEnd);
  }

  private stopVisualGfxSubgraphMove() {
    this.cancelGeometryPreview();
    this.moveVisualSubgraphId = "";
    this.moveVisualSubgraphTargetId = null;
    this.moveVisualSubgraphStart = null;
    this.host.previewVisualSubgraphReparent("", "");
    window.removeEventListener("pointermove", this.handleVisualGfxSubgraphMove);
    window.removeEventListener(
      "pointerup",
      this.handleVisualGfxSubgraphMoveEnd,
    );
  }

  private stopVisualGfxSubgraphResize() {
    this.cancelGeometryPreview();
    this.resizeVisualSubgraphId = "";
    this.resizeVisualSubgraphStart = null;
    window.removeEventListener(
      "pointermove",
      this.handleVisualGfxSubgraphResize,
    );
    window.removeEventListener(
      "pointerup",
      this.handleVisualGfxSubgraphResizeEnd,
    );
  }

  private stopMermaidVisualViewportResize() {
    this.resizeViewportStart = null;
    window.removeEventListener(
      "pointermove",
      this.handleVisualViewportResizePointerMove,
    );
    window.removeEventListener(
      "pointerup",
      this.handleVisualViewportResizePointerUp,
    );
  }

  private stopVisualEdgeReconnect() {
    this.connectVisualNodePreview = null;
    this.reconnectVisualEdgeEndpoint = null;
    this.reconnectVisualEdgeFixedNodeId = "";
    this.reconnectVisualEdgeFixedPoint = null;
    this.reconnectVisualEdgeId = "";
    window.removeEventListener(
      "pointermove",
      this.handleVisualEdgeReconnectPointerMove,
    );
    window.removeEventListener(
      "pointerup",
      this.handleVisualEdgeReconnectPointerUp,
    );
    this.host.requestUpdate();
  }
}
