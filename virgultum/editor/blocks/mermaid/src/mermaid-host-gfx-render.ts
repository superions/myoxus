import { createMermaidClipboardPort } from "./clipboard.js";
import { FileSizeLimitProvider } from "@virgultum/shared/services";
import {
  insertMermaidBlockCommand,
  insertMermaidEdgelessDiagramCommand,
  duplicateMermaidBlockCommand,
} from "./commands.js";
import { SurfaceBlockComponent } from "@virgultum/block-surface";
import { mountShapeTextEditor } from "@virgultum/gfx-shape";
import {
  readMermaidGfxNodeId,
  readMermaidGfxEdgeId,
} from "./mermaid-gfx-metadata.js";
import { getMermaidGfxFamilyHooks } from "./families/runtime/gfx-family-hooks-registry.js";
import { readMermaidGfxMeta } from "./mermaid-gfx-metadata.js";
import { Bound } from "@virgultum/global/gfx";
import { getMermaidVisualModel } from "./commands.js";

import {
  renderMermaidGfxPageEditor,
  resolveMermaidGfxEditorState,
  type MermaidVisualModel,
} from "./families/runtime/gfx-host-contract.js";
import { isMermaidGfxEdgeReconnectable } from "./families/runtime/gfx-element-projection.js";
import {
  typeOwnedMermaidConnectionTargetsIncludeSubgraphs,
  typeOwnedMermaidGeometrySelection,
  typeOwnedMermaidAlignmentGuides,
  typeOwnedMermaidObjectEditAnchorSide,
} from "./families/runtime/gfx-owner-hooks.js";
import { resolveTypeOwnedMermaidGfxDeletionPlan } from "./families/runtime/gfx-graph-operations.js";
import { getMermaidFamilyRuntime } from "./families/runtime/registry.js";
import {
  isMermaidGfxFamilyProjection,
  type MermaidEditorShellProjection,
  type MermaidGfxActionContext,
  type MermaidGfxFamilyProjection,
  type MermaidGfxObjectEditIntent,
} from "./families/runtime/editor-capabilities.js";
import { MermaidFamilyReactHostIdentifier } from "./families/runtime/react-host.js";
import type { MermaidSelectionActionModel } from "./families/runtime/shell-contract.js";
import { mermaidMessages } from "./i18n.js";
import { resolveMermaidGfxProjection } from "./presentation/gfx-projection-owner.js";
import { exportMermaidMmdOwner } from "./edgeless-toolbar/mmd-file-actions.js";

import { createMermaidOwnerGfxSemanticStateKey } from "./mermaid-owner-gfx-store.js";

import { MermaidHostGfxSync } from "./mermaid-host-gfx-sync.js";
import { previewMermaidGfxModel } from "./families/runtime/gfx-preview.js";
import type { MermaidPageSelectionToolsContribution } from "./families/runtime/contracts.js";
import { selectMermaidGfxNodesPatch } from "./mermaid-gfx-selection-state.js";

export abstract class MermaidHostGfxRender extends MermaidHostGfxSync {
  private _resolveVisualAlignmentGuides(visualModel: MermaidVisualModel) {
    return typeOwnedMermaidAlignmentGuides(visualModel).flatMap((guide) => {
      const rects = guide.members.flatMap((memberId) => {
        const model = this._getVisualNodeGfxModel(memberId);
        const rect = model?.xywh
          ? this._gfxViewportBridge.getModelViewRect(model.xywh)
          : null;
        return rect ? [rect] : [];
      });
      if (rects.length < 2) return [];
      const left = Math.min(...rects.map((rect) => rect.left));
      const top = Math.min(...rects.map((rect) => rect.top));
      const right = Math.max(...rects.map((rect) => rect.left + rect.width));
      const bottom = Math.max(...rects.map((rect) => rect.top + rect.height));
      const points =
        guide.direction === "row"
          ? [
              { left, top: bottom },
              { left: right, top: bottom },
            ]
          : [
              { left: right, top },
              { left: right, top: bottom },
            ];
      return [{ ...guide, points }];
    });
  }

  private _resolveVisualAnchor(
    visualModel: MermaidVisualModel,
    ownerXYWH: string,
    kind:
      | "alignment"
      | "diagram"
      | "detail"
      | "edge"
      | "node"
      | "subgraph"
      | "title",
    id = "",
  ) {
    if (kind === "diagram" || kind === "title") {
      const rect = this._gfxViewportBridge.getModelViewRect(ownerXYWH);
      if (!rect) return null;
      if (kind === "title") {
        return { left: rect.left + rect.width / 2, top: rect.top };
      }
      return id === "end"
        ? { left: rect.left + rect.width, top: rect.top + rect.height }
        : { left: rect.left, top: rect.top };
    }
    if (kind === "alignment") {
      const guide = this._resolveVisualAlignmentGuides(visualModel).find(
        (candidate) => candidate.id === id,
      );
      const first = guide?.points[0];
      const last = guide?.points.at(-1);
      return first && last
        ? {
            left: (first.left + last.left) / 2,
            top: (first.top + last.top) / 2,
          }
        : null;
    }
    if (kind === "edge") {
      const labelPoint = this._gfxViewportBridge.getEdgeLabelViewPoint(id);
      if (labelPoint) return labelPoint;
      const xywh = this._getVisualEdgeGfxModel(id)?.xywh;
      const rect = xywh ? this._gfxViewportBridge.getModelViewRect(xywh) : null;
      return rect
        ? {
            left: rect.left + rect.width / 2,
            top: rect.top + rect.height / 2,
          }
        : null;
    }
    const model =
      kind === "detail"
        ? visualModel.nodes
            .flatMap((node) => this._getVisualNodeGfxDetailModels(node.id))
            .find(
              (detail) => readMermaidGfxMeta(detail, "mermaidDetailId") === id,
            )
        : kind === "node"
          ? this._getVisualNodeGfxModel(id)
          : this._getVisualSubgraphGfxModel(id);
    const rect = model?.xywh
      ? this._gfxViewportBridge.getModelViewRect(model.xywh)
      : null;
    const start =
      kind !== "detail" &&
      typeOwnedMermaidObjectEditAnchorSide(visualModel, kind, id) === "start";
    return rect
      ? { left: rect.left + (start ? 0 : rect.width), top: rect.top }
      : null;
  }

  protected _renderGfxEditor(
    visualModel: NonNullable<ReturnType<typeof getMermaidVisualModel>>,
    {
      displayOnly = false,
      actionTarget = null,
      embeddedFacadeSurface = false,
      hiddenObjectKeys = [],
      pageSelectionTools,
      projectActions,
      onNodePointerDown,
      onObjectEditIntent,
      onContainerActionIntent,
      resolveDetailVisibilityTarget,
      renderSurface = "gfx",
    }: {
      displayOnly?: boolean;
      actionTarget?: HTMLElement | null;
      embeddedFacadeSurface?: boolean;
      hiddenObjectKeys?: readonly string[];
      pageSelectionTools?: MermaidPageSelectionToolsContribution;
      onNodePointerDown?: (event: PointerEvent) => boolean;
      onObjectEditIntent?: (intent: MermaidGfxObjectEditIntent) => boolean;
      onContainerActionIntent?: () => boolean;
      resolveDetailVisibilityTarget?: () => {
        ownerId: string;
        detailId: string;
      } | null;
      projectActions?: (
        context: MermaidGfxActionContext,
      ) => MermaidGfxFamilyProjection | unknown;
      renderSurface?: "core-facade" | "gfx";
    } = {},
  ) {
    this._resolveDetailVisibilityTarget = resolveDetailVisibilityTarget;
    this._objectEditIntent = displayOnly ? undefined : onObjectEditIntent;
    this._familyNodePointerDown = displayOnly ? undefined : onNodePointerDown;
    this._containerActionIntent = displayOnly
      ? undefined
      : onContainerActionIntent;
    const resolution = resolveMermaidGfxProjection(this.model);
    const readonly =
      this.store.readonly || displayOnly || Boolean(resolution?.displayOnly);
    this._gfxViewportBridge.setHiddenObjectKeys(hiddenObjectKeys);
    // Command previews hide the committed bodies. Their old bounds must not
    // draw resize/connection chrome over a differently sized local candidate.
    const visibleSelectedItems = this._visualSelection.items.filter((item) => {
      const element =
        item.kind === "node"
          ? this._getVisualNodeGfxModel(item.editKey)
          : item.kind === "edge"
            ? this._getVisualEdgeGfxModel(item.editKey)
            : this._getVisualSubgraphGfxModel(item.editKey);
      const surface = this._gfxViewportBridge.getController()?.surfaceComponent;
      return (
        element &&
        !("hidden" in element && element.hidden) &&
        !(
          surface instanceof SurfaceBlockComponent &&
          surface.renderer?.isElementLocallyExcluded(item.gfxElementId)
        )
      );
    });
    const singleSelectedItem =
      visibleSelectedItems.length === 1 ? visibleSelectedItems[0] : null;
    const selectedObjectRects = visibleSelectedItems.flatMap((item) => {
      let xywh: string | null = null;
      if (item.kind === "edge") {
        const labelXYWH = this._getVisualEdgeGfxModel(item.editKey)?.labelXYWH;
        xywh = labelXYWH ? new Bound(...labelXYWH).serialize() : null;
      } else {
        const model =
          item.kind === "node"
            ? this._getVisualNodeGfxModel(item.editKey)
            : this._getVisualSubgraphGfxModel(item.editKey);
        xywh = model?.xywh ?? null;
      }
      const rect = xywh ? this._gfxViewportBridge.getModelViewRect(xywh) : null;
      return rect ? [{ ...rect, id: item.editKey, kind: item.kind }] : [];
    });
    const selectedNodeHandleProjection =
      singleSelectedItem?.kind === "node" ||
      (singleSelectedItem?.kind === "subgraph" &&
        typeOwnedMermaidConnectionTargetsIncludeSubgraphs(visualModel))
        ? this._getSelectedVisualNodeHandleProjection()
        : null;
    const selectedEdgeHandles =
      singleSelectedItem?.kind === "edge"
        ? this._getSelectedVisualEdgeHandles()
        : null;
    const selectedSubgraphHandleProjection =
      singleSelectedItem?.kind === "subgraph"
        ? this._getSelectedVisualSubgraphHandleProjection()
        : null;
    const inspector = resolveMermaidGfxEditorState({
      allowExpandedShapePalette:
        getMermaidFamilyRuntime(visualModel.diagramType)?.id === "flowchart",
      pendingShape: this._pendingVisualInsertShape,
      selectedEdgeId:
        singleSelectedItem?.kind === "edge" ? singleSelectedItem.editKey : "",
      selectedNodeId:
        singleSelectedItem?.kind === "node" ? singleSelectedItem.editKey : "",
      selectedSubgraphId:
        singleSelectedItem?.kind === "subgraph"
          ? singleSelectedItem.editKey
          : "",
      showAllShapes: this._showAllVisualShapes,
      visualModel,
    });

    if (!resolution) {
      return {
        actions: null,
        body: null,
        notice: {
          message: mermaidMessages.projectionOwnerMissing(),
          title: mermaidMessages.sourceFirstTitle(),
          tone: "warning",
        },
      } satisfies MermaidEditorShellProjection;
    }

    const embedded = this._isInEdgelessMode();

    const hasActiveInlineEditor = this._hasActiveInlineShapeTextEditor();
    const suppressObjectHandles =
      readonly ||
      hasActiveInlineEditor ||
      this._visualSelection.items.length > 1;
    // The source-sync key intentionally includes every GFX coordinate. Store
    // and render identity must not: remounting BlockStdScope on a free move or
    // resize would discard the accepted owner projection.
    const projectionOwnerStateKey = createMermaidOwnerGfxSemanticStateKey({
      diagramType: visualModel.diagramType,
    });
    const currentViewportElement = this._gfxViewportBridge.getViewportElement();
    const currentDisplayMode = currentViewportElement?.closest<HTMLElement>(
      ".myoxus-mermaid-gfx-editor",
    )?.dataset.mermaidDisplayMode;
    // A structural source change replaces the scoped query/store because its
    // visible element set is immutable. Capture the outgoing camera only when
    // it belongs to this same Page mode; the replacement scope restores that
    // exact camera once, instead of fitting or synthesizing another host state.
    const replacedViewport =
      (!embedded || !displayOnly) &&
      currentDisplayMode === (displayOnly ? "display" : "edit")
        ? this._gfxViewportBridge.captureViewport()
        : null;
    const hiddenKeys = new Set(hiddenObjectKeys),
      visibleProjection = {
        ...resolution,
        childElementIds: resolution.childElementIds.filter((id) => {
          const element = resolution.getElementById(id);
          return (
            !hiddenKeys.has(readMermaidGfxNodeId(element)) &&
            !hiddenKeys.has(readMermaidGfxEdgeId(element))
          );
        }),
      };
    const gfxStore = this._ownerGfx.getOwnerGfxStore(
      visibleProjection,
      projectionOwnerStateKey,
    );
    if (!gfxStore) {
      return {
        actions: null,
        body: null,
        notice: {
          message: mermaidMessages.projectionOwnerMissing(),
          title: mermaidMessages.sourceFirstTitle(),
          tone: "warning",
        },
      } satisfies MermaidEditorShellProjection;
    }

    const rendered = renderMermaidGfxPageEditor({
      displayOnly,
      embedded,
      embeddedEditing: this._isActiveEmbeddedGfxEditor(),
      gfxStore,
      handlers: {
        resolvePageSelectedItems: () =>
          this._visualSelection.items.map(({ editKey, kind }) => ({
            editKey,
            kind,
          })),
        onConnectorHandleKeydown:
          this._gfxSession.handleVisualConnectorHandleKeydown,
        onConnectorHandlePointerDown:
          this._gfxSession.handleVisualConnectorHandlePointerDown,
        onContextConnect: this._handleConnectSelectedVisualNodesFromContext,
        onEdgeReconnectKeydown:
          this._gfxSession.handleVisualEdgeReconnectKeydown,
        onEdgeReconnectPointerDown: (event, endpoint) =>
          this._gfxSession.handleVisualEdgeReconnectPointerDown(
            event,
            endpoint,
          ),
        onProjectionOwnerSelection: this._handleProjectionOwnerSelection,
        // The scoped surface emits derived connector path/label updates as
        // well as user edits. Only semantic owner drift may write the
        // Mermaid source; inline editors still use the explicit commit path at
        // their close boundary.
        onProjectionOwnerSurfaceMutation: () =>
          this._scheduleProjectionOwnerSourceSyncIfDrifted(),
        onProjectionOwnerViewportFit: () => {
          if (!embedded) {
            const scale = this._gfxViewportBridge.captureViewport()?.zoom;
            if (scale) {
              this._transitionPageViewport({
                mode: displayOnly ? "view" : "visual",
                scale,
                type: "resolved-scale",
              });
            }
          }
          this._reconcileScopedGfxSelectionViewport();
        },
        onProjectionOwnerViewportInteraction: () => {
          if (!displayOnly) this._markScopedGfxViewportUserPositioned();
        },
        onProjectionOwnerViewportMove: () => {
          // Floating controls follow the live transform, including viewport resize.
          this.requestUpdate();
          if (embedded) return;
          const mode = displayOnly ? "view" : "visual";
          const position = this._gfxViewportBridge.resolvePageScrollPosition(
            this._pageViewportState.resolvedScales[mode],
          );
          if (position) {
            this._transitionPageViewport({ mode, position, type: "position" });
          }
        },
        onProjectionOwnerViewportReady: () => {
          // Structural insertion keeps the existing camera/focus intent until
          // this mounted scoped viewport, rather than the outgoing projection,
          // is ready to host the stable inline editor.
          if (this._completePendingInsertedNodeProjection()) return;
          if (replacedViewport) {
            this._gfxViewportBridge.restoreViewport(replacedViewport);
            return;
          }
          if (embedded) return;
          if (!this._scopedGfxViewportUserPositioned) return;
          const mode = displayOnly ? "view" : "visual";
          this._gfxViewportBridge.applyPageScroll(
            this._pageViewportState.positions[mode],
            this._pageViewportState.resolvedScales[mode],
          );
        },
        onNodeResizeKeydown: (event) =>
          this._gfxSession.handleVisualGfxResizeHandleKeydown(event, "node"),
        onNodeResizePointerDown: (event) =>
          this._gfxSession.handleVisualGfxResizeHandlePointerDown(
            event,
            "node",
          ),
        onDetailSelect: getMermaidGfxFamilyHooks(visualModel)
          ?.detailSelectionViaFamilyControls
          ? (ownerKey, detailKey) => {
              this._selectVisualNode(ownerKey);
              // Keyboard focus can reach an offscreen compartment. Reveal it
              // before the family mounts floating controls at that anchor.
              this._ensureScopedGfxSelectionVisible();
              this._consumeVisualObjectIntent({
                action: "select",
                kind: "detail",
                id: detailKey,
                ownerId: ownerKey,
              });
            }
          : undefined,
        onDetailEdit: (ownerKey, detailKey) => {
          this._selectVisualNode(ownerKey);
          this._ensureScopedGfxSelectionVisible();
          this._consumeVisualObjectIntent({
            kind: "detail",
            id: detailKey,
            ownerId: ownerKey,
          });
        },
        onObjectFocus: (item) => this._handlePageVisualObjectFocus(item),
        onAlignmentGuideSelect: (guideId, memberIds) => {
          this._applyVisualSelectionPatch(
            selectMermaidGfxNodesPatch(memberIds),
          );
          this._visualAlignmentGuideId = guideId;
          const guide = typeOwnedMermaidAlignmentGuides(visualModel).find(
            (candidate) => candidate.id === guideId,
          );
          this._pageSelectionAnnouncement =
            mermaidMessages.pageSelectionAnnouncement(
              guide?.direction === "column"
                ? mermaidMessages.architectureAlignColumn()
                : mermaidMessages.architectureAlignRow(),
              memberIds.length,
            );
          this.requestUpdate();
        },
        onObjectKeydown: (event, item) =>
          this._handlePageVisualObjectKeydown(event, item, readonly),
        onPageSelectionGestureChange: (active) => {
          // Box selection is a native pointer session too. The central Page
          // selection owner pauses source sync before it requests a render.
          this._setVisualNodePointerSessionActive(active);
          this._transitionPageSelection({
            type: active ? "begin-gesture" : "end-gesture",
          });
        },
        onPageSelectionProjectionReady: () => {
          this._restoreSessionVisualSelection();
          this._reconcileVisualSelectionProjection();
          requestAnimationFrame(() => this._restoreVisualObjectFocus());
        },
        onPageSelectionOperation: (operation, baseIds, candidateIds) =>
          this._applyVisualSelectionGfxOperation(
            operation,
            baseIds,
            candidateIds,
          ),
        onStopEditorEvent: this._stopEditorEvent,
        onSubgraphMoveKeydown:
          this._gfxSession.handleVisualGfxSubgraphMoveHandleKeydown,
        onSubgraphMovePointerDown:
          this._gfxSession.handleVisualGfxSubgraphMoveHandlePointerDown,
        onSubgraphResizeKeydown: (event) =>
          this._gfxSession.handleVisualGfxResizeHandleKeydown(
            event,
            "subgraph",
          ),
        onSubgraphResizePointerDown: (event) =>
          this._gfxSession.handleVisualGfxResizeHandlePointerDown(
            event,
            "subgraph",
          ),
        onViewportClick: this._gfxViewportInteraction.clickListener,
        onViewportContextMenu: this._gfxViewportInteraction.contextMenuListener,
        onViewportDoubleClick: this._gfxViewportInteraction.doubleClickListener,
        onViewportFocus: {
          handleEvent: (event) =>
            this._handlePageVisualWorkareaFocus(event as FocusEvent),
        },
        onViewportFocusOut: {
          handleEvent: (event) =>
            this._handlePageVisualWorkareaFocusOut(event as FocusEvent),
        },
        onViewportPointerDown: this._gfxViewportInteraction.pointerDownListener,
        onViewportResizeKeydown:
          this._gfxSession.handleVisualViewportResizeKeydown,
        onViewportResizePointerDown: (event, viewportHeight) =>
          this._gfxSession.handleVisualViewportResizePointerDown(
            event,
            viewportHeight,
          ),
      },
      inspector,
      projectShell:
        renderSurface === "core-facade" && (!embedded || embeddedFacadeSurface)
          ? (workarea, workareaFooter) => {
              const selectedNodeSelectionIds =
                this._visualSelectionKeys("node");
              // Mixed box selection intentionally retains intersecting edges.
              // Node-scoped family actions consume the node candidates without
              // rewriting the semantic selection or its delete impact.
              const selectedNodeIds = selectedNodeSelectionIds;
              const selectedEdgeIds = this._visualSelectionKeys("edge");
              const selectedSubgraphIds = this._visualSelectionKeys("subgraph");
              const selection = {
                edgeId: selectedEdgeIds.at(-1),
                edgeIds: selectedEdgeIds,
                nodeId: selectedNodeSelectionIds.at(-1),
                nodeIds: selectedNodeSelectionIds,
                subgraphId: selectedSubgraphIds.at(-1),
                subgraphIds: selectedSubgraphIds,
              };
              const selectionCount = this._visualSelection.items.length;
              const hasSelection = selectionCount > 0;
              const deletionPlan = hasSelection
                ? resolveTypeOwnedMermaidGfxDeletionPlan(visualModel, selection)
                : null;
              const selectionAction = {
                confirmation: deletionPlan?.requiresConfirmation
                  ? {
                      description: mermaidMessages.selectionDeleteImpact(),
                      items: [...deletionPlan.impact],
                    }
                  : undefined,
                disabled: readonly || displayOnly || !deletionPlan,
                label: mermaidMessages.selectionDeleteCount(selectionCount),
                onSelect: this._handleDeleteVisualSelection,
              } satisfies MermaidSelectionActionModel;
              const projectedFamily = projectActions?.({
                clipboard: createMermaidClipboardPort(
                  this.std,
                  // Portalled focus proxies have no Std block path. Scope by
                  // the actual viewport instead of a block-ID registration.
                  (event) =>
                    Boolean(
                      this._visualSelection.items.length &&
                      (!embedded || this._isActiveEmbeddedGfxEditor()) &&
                      event
                        .composedPath()
                        .some(
                          (target) =>
                            target instanceof Element &&
                            target.matches(".myoxus-mermaid-gfx-viewport"),
                        ),
                    ),
                ),
                importFileSizeLimit: this.std.get(FileSizeLimitProvider)
                  .maxFileSize,
                insertDiagram: (source, visualModel, position) => {
                  if (this.std.store.readonly) return false;
                  const [, result] = embedded
                    ? this.std.command.exec(
                        insertMermaidEdgelessDiagramCommand,
                        { source, visualModel, position },
                      )
                    : this.std.command.exec(insertMermaidBlockCommand, {
                        source,
                        visualModel,
                        selectedModels: [this.model],
                        place: "after",
                      });
                  return Boolean(result?.insertedMermaidBlockId);
                },
                duplicateOwner: () => {
                  this.std.command.exec(duplicateMermaidBlockCommand, {
                    model: this.model,
                  });
                },
                beginNodePlacement: (onPlace) => {
                  this._handlePageSelectionToolChange("pointer");
                  this._clearVisualSelection();
                  this._pendingVisualNodePlacement = onPlace;
                  this._pendingVisualInsertShape = "rect";
                  this.requestUpdate();
                  // Placement is a canvas gesture. Escape must reach its
                  // owner rather than remain on the external toolbar button.
                  this._activateKeyboardTarget();
                },
                actionTarget,
                history: {
                  canUndo:
                    this._visualUndoStack.length > 0 || this.store.canUndo,
                  canRedo:
                    this._visualRedoStack.length > 0 || this.store.canRedo,
                  onUndo: this._handleUndo,
                  onRedo: this._handleRedo,
                },
                embedded,
                embeddedEditing: this._isActiveEmbeddedGfxEditor(),
                applyEdgePatch: (patch, options) =>
                  this._patchSelectedVisualEdge(patch, options),
                applyNodePatch: (patch, options) =>
                  this._patchSelectedVisualNode(patch, options),
                applySubgraphPatch: (patch, options) =>
                  this._patchSelectedVisualSubgraph(patch, options),
                applyVisualModel: (model, options) =>
                  this._applyVisualModel(model, options),
                getVisualModel: () =>
                  this._getMermaidVisualModelForEditing() ?? visualModel,
                subscribeDraftInvalidation: (invalidate) => {
                  const stopSource =
                    this.model.props.source$.subscribe(invalidate);
                  const stopReadonly =
                    this.store.readonly$.subscribe(invalidate);
                  return () => {
                    stopSource();
                    stopReadonly();
                  };
                },
                mountShapeDraft: (shape, draft) => {
                  const controller = this._gfxViewportBridge.getController();
                  const std = controller?.std;
                  const root =
                    std?.store.root && std.view.getBlock(std.store.root.id);
                  if (!std || !root) return null;
                  const editor = mountShapeTextEditor(shape, root, {
                    draft,
                    draftContainer: std.host,
                  });
                  return editor ? () => editor.cancelDraft() : null;
                },
                previewVisualModel: (candidate, options) => {
                  const first = visualModel.nodes.find((n) =>
                    this._getVisualNodeGfxModel(n.id),
                  );
                  const element =
                    first && this._getVisualNodeGfxModel(first.id);
                  const surface =
                    this._gfxViewportBridge.getController()?.surface ??
                    this.model.surface;
                  if (!surface) throw new Error("Missing visible GFX Surface");
                  const bound = element?.xywh
                    ? Bound.deserialize(element.xywh)
                    : Bound.deserialize(resolution.ownerXYWH);
                  const origin = new Bound(
                    bound.x - (first?.x ?? 0),
                    bound.y - (first?.y ?? 0),
                    bound.w,
                    bound.h,
                  );
                  const objects = resolution.childElementIds.flatMap((id) => {
                    const raw = resolution.getElementById(id);
                    const visible =
                      (raw &&
                        this._gfxViewportBridge
                          .getController()
                          ?.getElementById?.(raw.id)) ||
                      raw;
                    return visible &&
                      readMermaidGfxMeta(visible, "mermaidRole") !==
                        "mermaid-diagram-title" &&
                      typeof visible === "object" &&
                      "hidden" in visible &&
                      "stash" in visible &&
                      "pop" in visible
                      ? [
                          visible as {
                            hidden: boolean;
                            stash: (prop: string) => void;
                            pop: (prop: string) => void;
                          },
                        ]
                      : [];
                  });
                  const component =
                    this._gfxViewportBridge.getController()?.surfaceComponent;
                  const renderer =
                    component instanceof SurfaceBlockComponent
                      ? component.renderer
                      : null;
                  if (options?.scopeToViewport && !renderer)
                    throw new Error(
                      "Missing scoped GFX renderer for local preview",
                    );
                  const preview = previewMermaidGfxModel(candidate, {
                    hideOriginals:
                      options?.scopeToViewport && renderer
                        ? () =>
                            renderer.excludeElementsTemporarily(
                              new Set(
                                resolution.childElementIds.filter(
                                  (id) =>
                                    readMermaidGfxMeta(
                                      resolution.getElementById(id),
                                      "mermaidRole",
                                    ) !== "mermaid-diagram-title",
                                ),
                              ),
                            )
                        : undefined,
                    surface,
                    creator: this.model,
                    viewport:
                      this._gfxViewportBridge.getController()!.viewport!,
                    origin,
                    elements: objects,
                    refresh: () => {
                      this._refreshScopedGfxRenderer();
                      this.requestUpdate();
                    },
                  });
                  if (!options?.includeInNavigation) return preview;
                  const restoreNavigation =
                    this._gfxViewportBridge.includePreviewNavigationBounds(
                      candidate.nodes.flatMap((node) => {
                        const element = preview.resolveNode?.(node.id);
                        return element ? [element.elementBound] : [];
                      }),
                    );
                  this.requestUpdate();
                  return Object.assign(
                    () => {
                      preview();
                      restoreNavigation();
                      this.requestUpdate();
                    },
                    { resolveNode: preview.resolveNode },
                  );
                },
                addContainer: this._handleAddVisualSubgraph,
                addNode: this._handleAddVisualNode,
                applyLayout: this._handleResetVisualLayout,
                connect:
                  selectedNodeIds.length === 2
                    ? this._handleConnectSelectedVisualNodesFromContext
                    : selectedNodeIds.length === 1
                      ? this._handleToggleVisualConnection
                      : () => undefined,
                connecting: this._gfxSession.isConnectingVisualNodes,
                closeInspector: () => this._clearVisualSelection(),
                displayOnly,
                editNodeLabel: this._startSelectedVisualNodeTextEdit,
                exportMmd: () => exportMermaidMmdOwner(this.model),
                inspector,
                inspectorSuppressed: this._visualInspectorSuppressed,
                onEmbeddedActionsInsetChange: (height) =>
                  this._setEmbeddedGfxActionsSafeInset(height),
                pendingShape: this._pendingVisualInsertShape,
                pageSelection: this._getPageSelectionProjection(),
                pageViewport: this._getPageViewportProjection(
                  displayOnly ? "view" : "visual",
                ),
                reactHost:
                  this.std.getOptional(MermaidFamilyReactHostIdentifier) ??
                  null,
                readonly,
                selectedNodeIds,
                selectedItems: this._visualSelectionItems(),
                selectedAlignmentGuideId: this._visualAlignmentGuideId,
                selectedNodeAnchor:
                  singleSelectedItem?.kind !== "node"
                    ? null
                    : (selectedNodeHandleProjection?.connectPorts.find(
                        (handle) =>
                          handle.position[0] === 0.5 &&
                          handle.position[1] === 0,
                      ) ?? null),
                selectedEdgeAnchor:
                  singleSelectedItem?.kind !== "edge"
                    ? null
                    : (this._gfxViewportBridge.getEdgeLabelViewPoint(
                        this._visualSelectionAnchorKey("edge"),
                      ) ??
                      (selectedEdgeHandles
                        ? {
                            left:
                              (selectedEdgeHandles.source.left +
                                selectedEdgeHandles.target.left) /
                              2,
                            top:
                              (selectedEdgeHandles.source.top +
                                selectedEdgeHandles.target.top) /
                              2,
                          }
                        : null)),
                selectedSubgraphAnchor:
                  singleSelectedItem?.kind === "subgraph" &&
                  selectedSubgraphHandleProjection
                    ? {
                        left:
                          selectedSubgraphHandleProjection.move.left +
                          selectedSubgraphHandleProjection.move.width / 2,
                        top: selectedSubgraphHandleProjection.move.top,
                      }
                    : null,
                refreshWorkarea: () => this._refreshPageGfxViewport(),
                fitViewport: embedded
                  ? () => {
                      this._markScopedGfxViewportUserPositioned();
                      this._gfxViewportBridge.fitViewport(null);
                    }
                  : undefined,
                resolveReturnFocusTarget: () => {
                  const viewport = this.renderRoot.querySelector<HTMLElement>(
                    ".myoxus-mermaid-gfx-viewport",
                  );
                  if (!this._visualSelection.items.length) return viewport;
                  const selected = this._visualSelection.anchor;
                  return (
                    Array.from(
                      viewport?.querySelectorAll<HTMLElement>(
                        ".myoxus-mermaid-gfx-object-focus-proxy",
                      ) ?? [],
                    ).find(
                      (proxy) =>
                        proxy.dataset.mermaidEditKey === selected?.editKey &&
                        proxy.dataset.objectKind === selected?.kind,
                    ) ?? viewport
                  );
                },
                resolveVisualAnchor: (kind, id, visible = false) => {
                  const anchor = this._resolveVisualAnchor(
                    visualModel,
                    resolution.ownerXYWH,
                    kind,
                    id,
                  );
                  return anchor && visible
                    ? this._gfxViewportBridge.constrainFloatingAnchor(anchor)
                    : anchor;
                },
                viewportIdentity:
                  this._gfxViewportBridge.getController()?.viewport ??
                  this._gfxViewportBridge.getViewportElement() ??
                  undefined,
                resolveViewportPoint: ({ left, top }) =>
                  this._gfxViewportBridge.getModelPointFromClient(left, top),
                resolveVisualBounds: (kind, id, client = false) => {
                  const element =
                    kind === "edge"
                      ? this._getVisualEdgeGfxModel(id)
                      : kind === "node"
                        ? this._getVisualNodeGfxModel(id)
                        : this._getVisualSubgraphGfxModel(id);
                  const xywh =
                    kind === "diagram" ? resolution.ownerXYWH : element?.xywh;
                  const rect = xywh
                    ? this._gfxViewportBridge.getModelViewRect(xywh)
                    : null;
                  if (!rect || !client) return rect;
                  const start =
                      this._gfxViewportBridge.getClientPointFromView(rect),
                    end = this._gfxViewportBridge.getClientPointFromView({
                      left: rect.left + rect.width,
                      top: rect.top + rect.height,
                    });
                  return start && end
                    ? {
                        ...start,
                        width: end.left - start.left,
                        height: end.top - start.top,
                      }
                    : null;
                },
                selectionAction,
                selectContainer: (id) => this._selectVisualSubgraph(id),
                selectEdge: (id) => this._selectVisualEdge(id),
                selectNode: (id) => this._selectVisualNode(id),
                selectAfterProjection: (item, options) =>
                  this._queueVisualSelectionForProjection([item], options),
                selectManyAfterProjection: (items) =>
                  this._queueVisualSelectionForProjection(items),
                setContainerTitle: (value) =>
                  this._setVisualSubgraphTitle(value),
                setEdgeLabel: (value) => this._setVisualEdgeLabel(value),
                setEdgeLinkType: (value) =>
                  this._setVisualEdgeLinkType(String(value)),
                setEdgeStyle: (value) =>
                  this._setVisualEdgeStyle(String(value)),
                setEdgeVisualStyle: (value) =>
                  this._setVisualEdgeStyleStatement(value ?? ""),
                setNodeLabel: (value) => this._setVisualNodeLabel(value),
                setNodeShape: (value) =>
                  this._handleVisualShapeButton(value as never),
                setNodeStyle: (value) =>
                  this._setVisualNodeStyleClass(value ?? ""),
                editSubgraphTitle: () => {
                  const subgraphId = this._visualSelectionAnchorKey("subgraph");
                  if (subgraphId) {
                    this._startInlineSubgraphTextEdit(null, subgraphId);
                  }
                },
                setSubgraphDirection: (value) =>
                  this._setVisualSubgraphDirection(value),
                visualModel,
                workarea,
                workareaFooter,
              });
              const familyProjection = isMermaidGfxFamilyProjection(
                projectedFamily,
              )
                ? projectedFamily
                : {
                    actions: {
                      actions: [
                        {
                          disabled: displayOnly,
                          id: "gfx-family-actions",
                          label: mermaidMessages.visualEditorLabel(),
                        },
                      ],
                      portal: true,
                    },
                    body: projectedFamily ?? workarea,
                  };
              return {
                actions: {
                  ...familyProjection.actions,
                  selectionAction:
                    familyProjection.actions?.selectionAction ??
                    selectionAction,
                },
                body: familyProjection.body,
              } satisfies MermaidEditorShellProjection;
            }
          : undefined,
      isViewportUserPositioned: () => this._scopedGfxViewportUserPositioned,
      keyboardDetailItems:
        displayOnly || !this._objectEditIntent
          ? []
          : visualModel.nodes.flatMap((node) =>
              (node.details ?? [])
                .filter(
                  (detail, index, all) =>
                    detail.sourceKey &&
                    detail.kind !== "separator" &&
                    all.findIndex((d) => d.sourceKey === detail.sourceKey) ===
                      index,
                )
                .map((detail) => ({
                  ownerKey: node.id,
                  detailKey: detail.sourceKey!,
                  label: detail.label,
                })),
            ),
      keyboardSelectionItems: pageSelectionTools
        ? pageSelectionTools
            .resolveItems(visualModel)
            .filter(
              (
                item,
              ): item is typeof item & {
                kind: "edge" | "node" | "subgraph";
              } =>
                (item.kind === "edge" ||
                  item.kind === "node" ||
                  item.kind === "subgraph") &&
                pageSelectionTools.selectableKinds.includes(item.kind) &&
                !hiddenKeys.has(item.editKey),
            )
            .map((item) => {
              const edge =
                item.kind === "edge"
                  ? visualModel.edges.find(
                      (candidate) => candidate.id === item.editKey,
                    )
                  : null;
              return {
                editKey: item.editKey,
                kind: item.kind,
                label:
                  item.label ||
                  (item.kind === "node"
                    ? visualModel.nodes.find((node) => node.id === item.editKey)
                        ?.label
                    : item.kind === "edge"
                      ? edge?.label ||
                        (edge
                          ? `${visualModel.nodes.find((n) => n.id === edge.source)?.label ?? edge.source} → ${visualModel.nodes.find((n) => n.id === edge.target)?.label ?? edge.target}`
                          : "")
                      : visualModel.subgraphs?.find(
                          (subgraph) => subgraph.id === item.editKey,
                        )?.title) ||
                  item.editKey,
              };
            })
        : [],
      projectionOwnerStateKey,
      pageViewport: this._getPageViewportProjection(
        displayOnly ? "view" : "visual",
      ),
      pageSelectionTools,
      pendingShape: this._pendingVisualInsertShape,
      readonly,
      resolution,
      resolveFrameXYWH: () => {
        const current = resolveMermaidGfxProjection(this.model);
        return current?.ownerXYWH ?? resolution.ownerXYWH;
      },
      resolvePageSelectionTool: () => this._pageSelectionState.tool,
      resolveViewportPadding: () =>
        this._gfxViewportBridge.getViewportPadding(),
      resolveVisualModel: () =>
        this._getMermaidVisualModelForEditing() ?? visualModel,
      subscribeVisualModelChange: (onChange) =>
        this.model.props.source$.subscribe(onChange),
      resolveViewportHeight:
        displayOnly || embedded
          ? (autoViewportHeight) => autoViewportHeight
          : (autoViewportHeight) =>
              this._getVisualViewportHeight(autoViewportHeight),
      std: this.std,
      visualModel,
      visualState: {
        alignmentGuides: readonly
          ? []
          : this._resolveVisualAlignmentGuides(visualModel),
        connectionPreview: this._gfxSession.connectionPreview,
        contextMenu: this._visualContextMenu,
        contextMenuLabel: this._selectedVisualNodeContextLabel(visualModel),
        edgeReconnectHandles:
          suppressObjectHandles ||
          (inspector.selectedEdge &&
            !isMermaidGfxEdgeReconnectable(visualModel, inspector.selectedEdge))
            ? null
            : selectedEdgeHandles,
        keyboardFocusRect: (() => {
          const item = this._keyboardFocusedVisualItem;
          if (!item) return null;
          const model =
            item.kind === "node"
              ? this._getVisualNodeGfxModel(item.editKey)
              : item.kind === "edge"
                ? this._getVisualEdgeGfxModel(item.editKey)
                : this._getVisualSubgraphGfxModel(item.editKey);
          const xywh =
            item.kind === "edge" && model && "labelXYWH" in model
              ? model.labelXYWH
                ? new Bound(...model.labelXYWH).serialize()
                : model.xywh
              : model?.xywh;
          return xywh ? this._gfxViewportBridge.getModelViewRect(xywh) : null;
        })(),
        keyboardObjectFocused: Boolean(this._keyboardFocusedVisualItem),
        nodeConnectHandles: suppressObjectHandles
          ? []
          : (selectedNodeHandleProjection?.connectPorts ?? []),
        nodeResizeHandle:
          suppressObjectHandles ||
          !typeOwnedMermaidGeometrySelection(
            visualModel,
            this._visualSelectionKeys("node"),
          ).length
            ? null
            : (selectedNodeHandleProjection?.resize ?? null),
        showContextMenu: Boolean(
          !displayOnly &&
          this._visualContextMenu &&
          this._visualSelectionKeys("node").length === 2,
        ),
        selectionAnnouncement: this._pageSelectionAnnouncement,
        selectionBounds: (() => {
          const rects = selectedObjectRects;
          if (rects.length < 2) return null;
          const left = Math.min(...rects.map((rect) => rect.left));
          const top = Math.min(...rects.map((rect) => rect.top));
          const right = Math.max(
            ...rects.map((rect) => rect.left + rect.width),
          );
          const bottom = Math.max(
            ...rects.map((rect) => rect.top + rect.height),
          );
          return { height: bottom - top, left, top, width: right - left };
        })(),
        selectionRects: selectedObjectRects,
        subgraphDropPreview: this._visualSubgraphDropPreview,
        subgraphMoveHandle:
          suppressObjectHandles ||
          !typeOwnedMermaidGeometrySelection(
            visualModel,
            this._visualSelectionKeys("subgraph"),
          ).length
            ? null
            : (selectedSubgraphHandleProjection?.move ?? null),
        subgraphResizeHandle:
          suppressObjectHandles ||
          !typeOwnedMermaidGeometrySelection(
            visualModel,
            this._visualSelectionKeys("subgraph"),
          ).length
            ? null
            : (selectedSubgraphHandleProjection?.resize ?? null),
      },
    });
    return rendered && typeof rendered === "object" && "body" in rendered
      ? (rendered as MermaidEditorShellProjection)
      : ({
          actions: null,
          body: rendered,
        } satisfies MermaidEditorShellProjection);
  }
}
