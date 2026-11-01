import {
  readMermaidGfxNodeId,
  readMermaidGfxEdgeId,
} from "./mermaid-gfx-metadata.js";
import { calPanDeltaFromClientPoint } from "@virgultum/block-surface";
import { Bound, getCommonBound } from "@virgultum/global/gfx";
import type { MermaidBlockModel, ShapeElementModel } from "@virgultum/model";

import { getMermaidVisualModel } from "./commands/model-resolution.js";
import { MERMAID_GFX_DETAIL_ROLE } from "./families/runtime/gfx-element-roles.js";
import type { MermaidVisualModel } from "./families/runtime/gfx-model.js";
import type { MermaidGfxNodeConnectionPort } from "./families/runtime/gfx-family-hooks-contract.js";
import {
  typeOwnedMermaidConnectionTargetsIncludeSubgraphs,
  typeOwnedMermaidEdgeHitTestIncludesSubgraphs,
  typeOwnedMermaidMinimumReadableZoom,
  typeOwnedMermaidObjectEditAnchorSide,
} from "./families/runtime/gfx-owner-hooks.js";
import {
  resolveMermaidGfxProjection,
  type MermaidGfxProjection,
} from "./presentation/gfx-projection-owner.js";
import {
  mermaidGfxEdgeHandleViewPoints,
  mermaidGfxNodeHandleViewPoints,
  mermaidGfxSubgraphMoveHandleViewRect,
  mermaidGfxSubgraphResizeHandleViewPoint,
} from "./mermaid-gfx-handles.js";
import {
  findMermaidGfxEdgeIdByModelPoint,
  findMermaidGfxNodeIdByModelPoint,
  findMermaidGfxNodeModelByModelPoint,
  findMermaidGfxNodeModelFromNativeHits,
  findMermaidGfxSubgraphHeaderIdByModelPoint,
  findMermaidGfxSubgraphIdByModelPoint,
  getMermaidGfxHitTestModels,
  findMermaidGfxSubgraphCollapseIdByModelPoint,
  isMermaidGfxHitVisible,
} from "./mermaid-gfx-hit-testing.js";
import { readMermaidGfxMeta } from "./mermaid-gfx-metadata.js";
import {
  findMermaidGfxEdgeModelByVisualId,
  findMermaidGfxNodeModelByVisualId,
  findMermaidGfxSubgraphModelByVisualId,
  getMermaidGfxSelectionIdentity,
} from "./mermaid-gfx-selection.js";
import {
  createMermaidScopedGfxFitKey,
  resolveMermaidPageViewportCenterPosition,
  resolveMermaidPageViewportNavigationGeometry,
  resolveMermaidScopedModelPointFromClient,
  resolveMermaidScopedViewportZoom,
} from "./mermaid-gfx-viewport.js";
import {
  fitMermaidReadablePageViewport,
  MERMAID_SCOPED_GFX_PAGE_MIN_READABLE_ZOOM,
  MERMAID_SCOPED_GFX_VIEWPORT_PADDING,
} from "./scoped-gfx-editor.js";
import type {
  MermaidPageViewportPosition,
  MermaidPageZoom,
  MermaidPageZoomAnchor,
} from "./mermaid-page-viewport-state.js";
import { MermaidPageSelectionTool } from "./mermaid-page-selection-tool.js";

type MermaidScopedGfxController = {
  readonly std?: import("@virgultum/std").BlockStdScope;
  surface?: import("@virgultum/std/gfx").SurfaceBlockModel;
  getElementById?: (id: string) => unknown;
  getElementByPoint?: (
    x: number,
    y: number,
    options?: { all?: boolean; hitThreshold?: number },
  ) => unknown;
  selection?: {
    set?: (selection: { editing?: boolean; elements: string[] }) => void;
  };
  surfaceComponent?: { refresh?: () => void };
  viewport?: {
    applyDeltaCenter?: (deltaX: number, deltaY: number) => void;
    centerX?: number;
    centerY?: number;
    height?: number;
    refreshClientRect?: () => boolean;
    setViewport?: (
      zoom: number,
      center?: [number, number],
      smooth?: boolean,
      forceUpdate?: boolean,
    ) => void;
    setViewportByBound?: (
      bound: Bound,
      padding?: [number, number, number, number],
      smooth?: boolean,
      forceUpdate?: boolean,
    ) => void;
    toModelCoord?: (viewX: number, viewY: number) => [number, number];
    toModelCoordFromClientCoord?: (point: [number, number]) => [number, number];
    toViewCoord?: (x: number, y: number) => [number, number];
    viewScale?: number;
    viewportX?: number;
    viewportY?: number;
    width?: number;
    zoom?: number;
    viewportMoved?: { next?: (delta: [number, number]) => void };
  };
};

export type MermaidScopedGfxViewportSnapshot = {
  center: [number, number];
  zoom: number;
};

type MermaidNodeHandleModel = {
  xywh?: string;
};

export type MermaidGfxViewportBridgeHost = {
  getElement(): Element;
  getModel(): MermaidBlockModel;
  getRenderRoot(): ParentNode;
  getViewportSafeInsetBottom(): number;
};

/**
 * Centralizes the scoped GFX viewport boundary for Mermaid blocks.
 *
 * This bridge deliberately owns only lookup, coordinate conversion, hit-testing
 * and handle geometry. Selection state, command execution, source sync and
 * user-visible editing decisions stay in the block host or family session
 * controllers so geometry helpers cannot become a second editor state model.
 */
export class MermaidGfxViewportBridge {
  private previewNavigationBound: Bound | null = null;
  private previewNavigationRevision = 0;
  get pageNavigationRevision() {
    return this.previewNavigationRevision;
  }
  /** Viewport-local bounds; no model geometry or history is changed. */
  includePreviewNavigationBounds(bounds: readonly Bound[]) {
    const bound = getCommonBound([...bounds]);
    this.previewNavigationBound = bound ?? null;
    this.previewNavigationRevision++;
    return () => {
      if (this.previewNavigationBound === bound) {
        this.previewNavigationBound = null;
        this.previewNavigationRevision++;
      }
    };
  }
  private hiddenObjectKeys = new Set<string>();
  setHiddenObjectKeys(keys: readonly string[]) {
    this.hiddenObjectKeys = new Set(keys);
  }
  constructor(private readonly host: MermaidGfxViewportBridgeHost) {}

  getViewportPadding(): [number, number, number, number] {
    const [top, right, bottom, left] = MERMAID_SCOPED_GFX_VIEWPORT_PADDING;
    return [
      top,
      right,
      bottom + Math.max(0, this.host.getViewportSafeInsetBottom()),
      left,
    ];
  }

  private getViewportProjection() {
    const viewport = this.getController()?.viewport;
    const viewportX = viewport?.viewportX;
    const viewportY = viewport?.viewportY;
    const zoom = viewport?.zoom;
    if (
      typeof viewportX !== "number" ||
      !Number.isFinite(viewportX) ||
      typeof viewportY !== "number" ||
      !Number.isFinite(viewportY) ||
      typeof zoom !== "number" ||
      !Number.isFinite(zoom) ||
      zoom <= 0
    ) {
      return null;
    }
    const rawViewScale = viewport?.viewScale;
    const viewScale =
      typeof rawViewScale === "number" &&
      Number.isFinite(rawViewScale) &&
      rawViewScale > 0
        ? rawViewScale
        : 1;
    return { viewScale, viewportX, viewportY, zoom };
  }

  private getManagedContentBound(resolution: MermaidGfxProjection) {
    return (
      getCommonBound([
        ...resolution.childElementIds.flatMap((id) => {
          const model = resolution.getElementById(id);
          return model ? [model.elementBound] : [];
        }),
        ...(this.previewNavigationBound ? [this.previewNavigationBound] : []),
      ]) ?? Bound.deserialize(resolution.ownerXYWH)
    );
  }

  private get projection() {
    const projection = resolveMermaidGfxProjection(this.host.getModel());
    if (
      !projection ||
      (!this.hiddenObjectKeys.size && !this.previewNavigationBound)
    )
      return projection;
    return {
      ...projection,
      ownerXYWH: this.previewNavigationBound
        ? getCommonBound([
            Bound.deserialize(projection.ownerXYWH),
            this.previewNavigationBound,
          ])!.serialize()
        : projection.ownerXYWH,
      childElementIds: projection.childElementIds.filter((id) => {
        const element = projection.getElementById(id);
        return (
          !this.hiddenObjectKeys.has(readMermaidGfxNodeId(element)) &&
          !this.hiddenObjectKeys.has(readMermaidGfxEdgeId(element))
        );
      }),
    };
  }

  private get diagramType() {
    const value = this.host.getModel().props.diagramType;
    return typeof value === "string" ? value : "";
  }

  private get minimumReadableZoom() {
    const model = getMermaidVisualModel(this.host.getModel());
    return model
      ? typeOwnedMermaidMinimumReadableZoom(
          model,
          MERMAID_SCOPED_GFX_PAGE_MIN_READABLE_ZOOM,
        )
      : MERMAID_SCOPED_GFX_PAGE_MIN_READABLE_ZOOM;
  }

  getViewportElement() {
    return (
      this.host.getRenderRoot().querySelector(".myoxus-mermaid-gfx-viewport") ??
      this.host.getElement().querySelector(".myoxus-mermaid-gfx-viewport")
    );
  }

  getController(): MermaidScopedGfxController | null {
    const surfaceElement = this.getViewportElement()?.querySelector(
      "myoxus-surface",
    ) as
      | {
          _gfx?: MermaidScopedGfxController;
        }
      | null
      | undefined;
    return surfaceElement?._gfx ?? null;
  }

  cancelPageSelectionGesture() {
    const tool = (
      this.getController() as
        | (MermaidScopedGfxController & {
            tool?: { currentTool$?: { peek?: () => unknown } };
          })
        | null
    )?.tool?.currentTool$?.peek?.();
    if (!(tool instanceof MermaidPageSelectionTool)) return false;
    tool.cancelPageGesture();
    return true;
  }

  private getScopedModel<T extends { id?: string }>(model: T | null) {
    if (!model?.id) return model;
    return (
      (this.getController()?.getElementById?.(String(model.id)) as T | null) ??
      model
    );
  }

  captureViewport(): MermaidScopedGfxViewportSnapshot | null {
    const viewport = this.getController()?.viewport;
    if (
      !viewport ||
      !Number.isFinite(viewport.centerX) ||
      !Number.isFinite(viewport.centerY) ||
      !Number.isFinite(viewport.zoom)
    ) {
      return null;
    }
    return {
      center: [viewport.centerX!, viewport.centerY!],
      zoom: viewport.zoom!,
    };
  }

  restoreViewport(snapshot: MermaidScopedGfxViewportSnapshot | null) {
    if (!snapshot) return;
    this.getController()?.viewport?.setViewport?.(
      snapshot.zoom,
      snapshot.center,
      false,
      true,
    );
  }

  refreshClientRect() {
    const changed =
      this.getController()?.viewport?.refreshClientRect?.() ?? false;
    this.positionEmbeddedActions();
    return changed;
  }

  /** The Note transform can leave the bottom of a tall diagram offscreen.
   * Keep its existing 3E toolbar in the same visible excerpt as object controls;
   * these offsets are renderer geometry, while Facade still owns all chrome. */
  private positionEmbeddedActions() {
    const toolbar = this.host
      .getRenderRoot()
      .querySelector<HTMLElement>(
        '[data-myoxus-ui-role="mermaid-embedded-actions"][data-placement="bottom-overlay"]',
      );
    const parent = toolbar?.offsetParent;
    const viewport = this.getViewportElement();
    if (!toolbar || !(parent instanceof HTMLElement) || !viewport) return;
    const rect = viewport.getBoundingClientRect(),
      parentRect = parent.getBoundingClientRect(),
      scale = parent.offsetWidth ? parentRect.width / parent.offsetWidth : 0;
    if (!(scale > 0) || !(rect.width > 0) || !(rect.height > 0)) return;
    const visible = this.visibleViewportBounds(rect.width, rect.height);
    const dock = this.host
      .getElement()
      .closest("myoxus-edgeless-root")
      ?.querySelector("edgeless-toolbar-widget")
      ?.getBoundingClientRect();
    if (dock && dock.height > 0 && dock.top > rect.top) {
      visible.bottom = Math.min(visible.bottom, dock.top - rect.top);
    }
    const bottom = Math.max(
      0,
      (parentRect.bottom - rect.top - visible.bottom) / scale,
    );
    toolbar.style.bottom = `calc(var(--mantine-spacing-lg) + ${bottom}px)`;
    toolbar.style.left = `${(rect.left + (visible.left + visible.right) / 2 - parentRect.left) / scale}px`;
    toolbar.style.maxWidth = `calc(${(visible.right - visible.left) / scale}px - var(--mantine-spacing-lg) * 2)`;
  }

  getModelPointFromClient(clientX: number, clientY: number) {
    const viewportController = this.getController()?.viewport;
    const viewport = this.getViewportElement();
    const viewportRect = viewport?.getBoundingClientRect();
    const resolution = this.projection;
    if (!resolution || !viewportRect) return null;
    const projection = this.getViewportProjection();
    if (projection) {
      // GFX block/canvas rendering already compensates an ancestor transform
      // with `viewScale`. Client deltas are physical pixels and therefore map
      // through the fitted GFX zoom exactly once. Passing them through
      // Viewport.toModelCoord would divide by viewScale a second time and make
      // embedded Note hits drift away from the visible object.
      return {
        x:
          projection.viewportX +
          (clientX - viewportRect.left) / projection.zoom,
        y:
          projection.viewportY + (clientY - viewportRect.top) / projection.zoom,
      };
    }
    return resolveMermaidScopedModelPointFromClient({
      clientX,
      clientY,
      ownerBound: Bound.deserialize(resolution.ownerXYWH),
      minReadableZoom: this.minimumReadableZoom,
      padding: MERMAID_SCOPED_GFX_VIEWPORT_PADDING,
      viewportController,
      viewportRect,
    });
  }

  getModelDeltaFromClient(dx: number, dy: number) {
    const zoom = this.getController()?.viewport?.zoom;
    if (!Number.isFinite(zoom) || !zoom || zoom <= 0) return null;
    return { dx: dx / zoom, dy: dy / zoom };
  }

  panViewportNearClientPoint(
    clientX: number,
    clientY: number,
    maxViewDelta?: number,
  ) {
    const viewportElement = this.getViewportElement();
    const viewport = this.getController()?.viewport;
    if (
      !(viewportElement instanceof HTMLElement) ||
      !viewport?.applyDeltaCenter ||
      !Number.isFinite(viewport.zoom) ||
      !viewport.zoom ||
      viewport.zoom <= 0
    ) {
      return null;
    }
    const rect = viewportElement.getBoundingClientRect();
    const viewDelta = calPanDeltaFromClientPoint({
      clientX,
      clientY,
      height: rect.height,
      left: rect.left,
      maxDelta: maxViewDelta,
      top: rect.top,
      width: rect.width,
    });
    if (!viewDelta) return null;
    const [viewDx, viewDy] = viewDelta;
    const dx = viewDx / viewport.zoom;
    const dy = viewDy / viewport.zoom;
    viewport.applyDeltaCenter(dx, dy);
    viewport.viewportMoved?.next?.([dx, dy]);
    return { dx, dy };
  }

  getViewPointFromClient(clientX: number, clientY: number) {
    const viewport = this.getViewportElement();
    if (!(viewport instanceof HTMLElement)) return null;
    const rect = viewport.getBoundingClientRect();
    const viewScale = this.getViewportProjection()?.viewScale ?? 1;
    // Preview SVG and HTML overlays live in the viewport's local CSS space.
    // Undo the outer Edgeless transform once before assigning CSS positions.
    return {
      left: (clientX - rect.left) / viewScale,
      top: (clientY - rect.top) / viewScale,
    };
  }

  getClientPointFromView(point: { left: number; top: number }) {
    const rect = this.getViewportElement()?.getBoundingClientRect();
    if (!rect) return null;
    const scale = this.getViewportProjection()?.viewScale ?? 1;
    return {
      left: rect.left + point.left * scale,
      top: rect.top + point.top * scale,
    };
  }

  /** Floating controls stay in the clipped excerpt without moving the object
   * or clamping its renderer/comment geometry. Points use local CSS space. */
  constrainFloatingAnchor(point: { left: number; top: number }) {
    const rect = this.getViewportElement()?.getBoundingClientRect();
    if (!rect) return point;
    const visible = this.visibleViewportBounds(rect.width, rect.height);
    const scale = this.getViewportProjection()?.viewScale ?? 1;
    const [top, right, bottom, left] = this.getViewportPadding();
    const minX = (visible.left + left) / scale;
    const maxX = Math.max(minX, (visible.right - right) / scale);
    const minY = (visible.top + top) / scale;
    const maxY = Math.max(minY, (visible.bottom - bottom) / scale);
    return {
      left: Math.max(minX, Math.min(maxX, point.left)),
      top: Math.max(minY, Math.min(maxY, point.top)),
    };
  }

  toViewPoint(x: number, y: number) {
    const viewport = this.getController()?.viewport;
    const projection = this.getViewportProjection();
    if (projection) {
      // These coordinates are assigned to DOM overlays inside the transformed
      // viewport. Mirror GfxBlockComponent's zoom/viewScale projection so the
      // selection chrome, handles, local actions and inline editor share the
      // exact screen geometry of the rendered owner element.
      return {
        left:
          ((x - projection.viewportX) * projection.zoom) / projection.viewScale,
        top:
          ((y - projection.viewportY) * projection.zoom) / projection.viewScale,
      };
    }
    const point = viewport?.toViewCoord?.(x, y);
    if (!point || !Number.isFinite(point[0]) || !Number.isFinite(point[1])) {
      return null;
    }
    return { left: point[0], top: point[1] };
  }

  createFitKey() {
    const resolution = this.projection;
    if (!resolution) return "";
    return createMermaidScopedGfxFitKey({
      elementIds: resolution.childElementIds,
      ownerXywh: resolution.ownerXYWH,
    });
  }

  fitViewport(minReadableZoom: number | null = this.minimumReadableZoom) {
    const resolution = this.projection;
    if (!resolution) return;
    const viewport = this.getController()?.viewport;
    if (!viewport || viewport.height == null || viewport.width == null) return;
    fitMermaidReadablePageViewport({
      bound: Bound.deserialize(resolution.ownerXYWH),
      minReadableZoom,
      padding: this.getViewportPadding(),
      // Keep the original viewport receiver. Its methods mutate internal
      // viewport state via `this`, so copying method references breaks runtime
      // fitting even though TypeScript accepts the structural shape.
      viewport: viewport as {
        height: number;
        setViewport?: (
          zoom: number,
          center?: [number, number],
          smooth?: boolean,
          forceUpdate?: boolean,
        ) => void;
        setViewportByBound?: (
          bound: Bound,
          padding?: [number, number, number, number],
          smooth?: boolean,
          forceUpdate?: boolean,
        ) => void;
        width: number;
      },
    });
  }

  zoomViewportTo(zoom: number) {
    const resolution = this.projection;
    if (!resolution) return;
    const viewport = this.getController()?.viewport;
    if (!viewport?.setViewport) return;
    const bound = Bound.deserialize(resolution.ownerXYWH);
    const target = resolveMermaidScopedViewportZoom({
      ownerBound: bound,
      zoom,
    });
    if (!target) return;
    viewport.setViewport(target.zoom, target.center, false, true);
  }

  applyPageZoom(zoom: MermaidPageZoom, anchor: MermaidPageZoomAnchor) {
    if (zoom === "auto") {
      // Explicit Auto requests the complete diagram, independently of the
      // family's readable initial camera. Fixed zoom remains user-controlled.
      this.fitViewport(null);
      return this.captureViewport()?.zoom ?? null;
    }
    const resolution = this.projection;
    const viewport = this.getController()?.viewport;
    const viewportElement = this.getViewportElement();
    if (
      !resolution ||
      !viewport?.setViewport ||
      viewport.width == null ||
      viewport.height == null
    ) {
      return null;
    }
    const scale = zoom / 100;
    const ownerBound = Bound.deserialize(resolution.ownerXYWH);
    let center: [number, number] = [
      Number.isFinite(viewport.centerX)
        ? viewport.centerX!
        : ownerBound.x + ownerBound.w / 2,
      Number.isFinite(viewport.centerY)
        ? viewport.centerY!
        : ownerBound.y + ownerBound.h / 2,
    ];
    if (
      anchor.type === "pointer" &&
      viewport.toModelCoord &&
      viewportElement instanceof Element
    ) {
      const rect = viewportElement.getBoundingClientRect();
      const viewX = anchor.clientX - rect.left;
      const viewY = anchor.clientY - rect.top;
      const modelPoint = viewport.toModelCoord(viewX, viewY);
      center = [
        modelPoint[0] - (viewX - viewport.width / 2) / scale,
        modelPoint[1] - (viewY - viewport.height / 2) / scale,
      ];
    }
    viewport.setViewport(scale, center, false, true);
    return scale;
  }

  resolvePageCenterPosition(scale: number): MermaidPageViewportPosition | null {
    const resolution = this.projection;
    const viewport = this.getController()?.viewport;
    if (!resolution || viewport?.width == null || viewport.height == null) {
      return null;
    }
    return resolveMermaidPageViewportCenterPosition({
      contentBound: this.getManagedContentBound(resolution),
      navigationBound: Bound.deserialize(resolution.ownerXYWH),
      padding: MERMAID_SCOPED_GFX_VIEWPORT_PADDING,
      scale,
      viewportRect: { height: viewport.height, width: viewport.width },
    });
  }

  resolvePageNavigationGeometry(scale: number) {
    const resolution = this.projection;
    const viewport = this.getController()?.viewport;
    if (!resolution || viewport?.width == null || viewport.height == null) {
      return null;
    }
    return resolveMermaidPageViewportNavigationGeometry({
      contentBound: this.getManagedContentBound(resolution),
      navigationBound: Bound.deserialize(resolution.ownerXYWH),
      padding: MERMAID_SCOPED_GFX_VIEWPORT_PADDING,
      scale,
      viewportRect: { height: viewport.height, width: viewport.width },
    });
  }

  applyPageScroll(position: MermaidPageViewportPosition, scale: number) {
    const resolution = this.projection;
    const viewport = this.getController()?.viewport;
    if (
      !resolution ||
      !viewport?.setViewport ||
      viewport.width == null ||
      viewport.height == null ||
      !Number.isFinite(scale) ||
      scale <= 0
    ) {
      return false;
    }
    const [pt, , , pl] = MERMAID_SCOPED_GFX_VIEWPORT_PADDING;
    const bound = Bound.deserialize(resolution.ownerXYWH);
    const contentBound = this.getManagedContentBound(resolution);
    const geometry = resolveMermaidPageViewportNavigationGeometry({
      contentBound,
      navigationBound: bound,
      padding: MERMAID_SCOPED_GFX_VIEWPORT_PADDING,
      scale,
      viewportRect: { height: viewport.height, width: viewport.width },
    });
    if (!geometry) return false;
    const horizontalOverflow = geometry.width > viewport.width;
    const verticalOverflow = geometry.height > viewport.height;
    viewport.setViewport(
      scale,
      [
        horizontalOverflow
          ? bound.x -
            pl +
            (position.scrollLeft - geometry.insetLeft) / scale +
            viewport.width / scale / 2
          : contentBound.x + contentBound.w / 2,
        verticalOverflow
          ? bound.y -
            pt +
            (position.scrollTop - geometry.insetTop) / scale +
            viewport.height / scale / 2
          : contentBound.y + contentBound.h / 2,
      ],
      false,
      true,
    );
    return true;
  }

  resolvePageScrollPosition(scale: number): MermaidPageViewportPosition | null {
    const resolution = this.projection;
    const viewport = this.getController()?.viewport;
    if (
      !resolution ||
      viewport?.width == null ||
      viewport.height == null ||
      !Number.isFinite(viewport.centerX) ||
      !Number.isFinite(viewport.centerY) ||
      !Number.isFinite(scale) ||
      scale <= 0
    ) {
      return null;
    }
    const [pt, , , pl] = MERMAID_SCOPED_GFX_VIEWPORT_PADDING;
    const bound = Bound.deserialize(resolution.ownerXYWH);
    const contentBound = this.getManagedContentBound(resolution);
    const geometry = resolveMermaidPageViewportNavigationGeometry({
      contentBound,
      navigationBound: bound,
      padding: MERMAID_SCOPED_GFX_VIEWPORT_PADDING,
      scale,
      viewportRect: { height: viewport.height, width: viewport.width },
    });
    if (!geometry) return null;
    return {
      scrollLeft:
        geometry.width <= viewport.width
          ? 0
          : Math.max(
              0,
              geometry.insetLeft +
                (viewport.centerX! -
                  viewport.width / scale / 2 -
                  bound.x +
                  pl) *
                  scale,
            ),
      scrollTop:
        geometry.height <= viewport.height
          ? 0
          : Math.max(
              0,
              geometry.insetTop +
                (viewport.centerY! -
                  viewport.height / scale / 2 -
                  bound.y +
                  pt) *
                  scale,
            ),
    };
  }

  ensureNodeVisible(nodeId: string) {
    const model = this.getNodeModel(nodeId);
    if (model?.xywh) {
      const bound = Bound.deserialize(model.xywh);
      const visual = getMermaidVisualModel(this.host.getModel());
      this.ensureBoundVisible(
        bound,
        Boolean(
          visual &&
          typeOwnedMermaidObjectEditAnchorSide(visual, "node", nodeId) ===
            "start",
        ),
      );
    }
  }

  ensureDetailVisible(nodeId: string, detailId: string) {
    const model = this.getNodeDetailModels(nodeId).find(
      (detail) =>
        readMermaidGfxMeta(detail, "mermaidDetailId") === detailId ||
        readMermaidGfxMeta(detail, "mermaidDetailSourceKey") === detailId,
    );
    if (!model?.xywh) return false;
    const bound = Bound.deserialize(model.xywh);
    // Compartment forms share the row's top-right anchor. Revealing the whole
    // record can clip a long name column or a row below the visible excerpt.
    this.ensureBoundVisible(new Bound(bound.maxX, bound.y, 0, 0));
    return true;
  }

  ensureEdgeVisible(edgeId: string) {
    const model = this.getEdgeModel(edgeId);
    // Object controls anchor to the label, not the potentially much larger
    // connector bounds. Revealing the latter can leave the editor offscreen.
    if (model?.labelXYWH) {
      this.ensureBoundVisible(new Bound(...model.labelXYWH));
    } else if (model?.xywh) {
      this.ensureBoundVisible(Bound.deserialize(model.xywh));
    }
  }

  ensureSubgraphVisible(subgraphId: string) {
    const model = this.getSubgraphModel(subgraphId);
    if (model?.xywh) {
      const bound = Bound.deserialize(model.xywh);
      // Reveal the family's heading edge. A tall enclosing box's lower edge
      // can hide that anchor and its popover.
      const visual = getMermaidVisualModel(this.host.getModel());
      const start =
        visual &&
        typeOwnedMermaidObjectEditAnchorSide(visual, "subgraph", subgraphId) ===
          "start";
      this.ensureBoundVisible(
        new Bound(start ? bound.x : bound.maxX, bound.y, 0, 0),
      );
    }
  }

  private ensureBoundVisible(bound: Bound, startForOversized = false) {
    const viewport = this.getController()?.viewport;
    if (
      !viewport ||
      viewport.width == null ||
      viewport.height == null ||
      !Number.isFinite(viewport.centerX) ||
      !Number.isFinite(viewport.centerY) ||
      !Number.isFinite(viewport.zoom) ||
      !viewport.toViewCoord ||
      !viewport.setViewport
    ) {
      return;
    }

    const projection = this.getViewportProjection();
    // Compare physical pixels with the physical client rect. GFX rendering
    // cancels an ancestor Note scale; toViewCoord applies that scale again.
    const [left, top] = projection
      ? [
          (bound.x - projection.viewportX) * projection.zoom,
          (bound.y - projection.viewportY) * projection.zoom,
        ]
      : viewport.toViewCoord(bound.x, bound.y);
    let [right, bottom] = projection
      ? [left + bound.w * projection.zoom, top + bound.h * projection.zoom]
      : viewport.toViewCoord(bound.x + bound.w, bound.y + bound.h);
    const [pt, pr, pb, pl] = this.getViewportPadding();
    const visible = this.visibleViewportBounds(viewport.width, viewport.height);
    const rect = this.getViewportElement()?.getBoundingClientRect();
    if (rect) {
      const controls = [
        this.host
          .getRenderRoot()
          .querySelector('[data-myoxus-ui-role="mermaid-embedded-actions"]'),
        this.host
          .getElement()
          .closest("myoxus-edgeless-root")
          ?.querySelector("edgeless-toolbar-widget"),
      ];
      for (const control of controls) {
        const bounds = control?.getBoundingClientRect();
        if (
          bounds &&
          bounds.height > 0 &&
          bounds.top > rect.top &&
          bounds.left < rect.right &&
          bounds.right > rect.left
        ) {
          // Padding already contains the measured action height. Cancel that
          // reserve when clipping to its painted top, leaving base clearance.
          // Keep this out of toolbar positioning to avoid self-clipping drift.
          visible.bottom = Math.min(
            visible.bottom,
            bounds.top - rect.top + this.host.getViewportSafeInsetBottom(),
          );
        }
      }
    }
    const minX = visible.left + pl,
      maxX = visible.right - pr;
    const minY = visible.top + pt,
      maxY = visible.bottom - pb;
    // A floating start anchor must not reduce a fitting node to a zero-size
    // focus target. Oversized records retain their existing header reveal.
    if (startForOversized) {
      if (right - left > maxX - minX) right = left;
      if (bottom - top > maxY - minY) bottom = top;
    }
    let offsetX = 0;
    let offsetY = 0;
    // Oversized record boxes cannot fit completely. Keep their top-right
    // header editor anchor visible instead of alternating between both edges.
    if (right - left > maxX - minX) {
      offsetX = right - maxX;
    } else if (left < minX) offsetX = left - minX;
    else if (right > maxX) {
      offsetX = right - maxX;
    }
    if (bottom - top > maxY - minY || top < minY) {
      offsetY = top - minY;
    } else if (bottom > maxY) {
      offsetY = bottom - maxY;
    }
    if (offsetX === 0 && offsetY === 0) return;

    viewport.setViewport(
      viewport.zoom!,
      [
        viewport.centerX! + offsetX / viewport.zoom!,
        viewport.centerY! + offsetY / viewport.zoom!,
      ],
      false,
      true,
    );
  }

  /** Reveal anchors in the actual physical excerpt clipped by the Page scroller
   * or desktop viewport. Embedded rendering cancels the Note transform, so its
   * CSS-space viewport width must not rescale these physical bounds a second time. */
  private visibleViewportBounds(width: number, height: number) {
    const full = { left: 0, top: 0, right: width, bottom: height };
    const element = this.getViewportElement();
    if (!(element instanceof HTMLElement)) return full;
    let rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return full;
    if (
      rect.bottom <= 0 ||
      rect.top >= window.innerHeight ||
      rect.right <= 0 ||
      rect.left >= window.innerWidth
    ) {
      element.scrollIntoView({ block: "nearest", inline: "nearest" });
      rect = element.getBoundingClientRect();
    }
    let left = Math.max(0, rect.left),
      top = Math.max(0, rect.top);
    let right = Math.min(window.innerWidth, rect.right);
    let bottom = Math.min(window.innerHeight, rect.bottom);
    for (
      let parent = element.parentElement;
      parent;
      parent = parent.parentElement
    ) {
      const style = getComputedStyle(parent),
        clip = parent.getBoundingClientRect();
      if (/auto|scroll|hidden|clip/.test(style.overflowX)) {
        left = Math.max(left, clip.left);
        right = Math.min(right, clip.right);
      }
      if (/auto|scroll|hidden|clip/.test(style.overflowY)) {
        top = Math.max(top, clip.top);
        bottom = Math.min(bottom, clip.bottom);
      }
    }
    if (right <= left || bottom <= top) return full;
    return {
      left: left - rect.left,
      right: right - rect.left,
      top: top - rect.top,
      bottom: bottom - rect.top,
    };
  }

  findNodeByModelPoint(x: number, y: number) {
    const resolution = this.projection;
    if (!resolution) return "";

    return findMermaidGfxNodeIdByModelPoint(
      getMermaidGfxHitTestModels({
        elementIds: resolution.childElementIds,
        getModel: resolution.getElementById,
      }),
      x,
      y,
    );
  }

  getNodeDetailModels(nodeId: string) {
    const resolution = this.projection;
    if (!resolution) return [];
    return resolution.childElementIds.flatMap((elementId) => {
      const model = resolution.getElementById(elementId);
      return readMermaidGfxMeta(model, "mermaidRole") ===
        MERMAID_GFX_DETAIL_ROLE &&
        readMermaidGfxMeta(model, "mermaidDetailOwnerNodeId") === nodeId
        ? // Gesture previews must use the visible Surface wrapper, just like
          // the owning node. Stashing the persisted owner's wrapper leaves its
          // scoped member rows behind even though they share the same Y.Map.
          [this.getScopedModel(model)]
        : [];
    });
  }

  findSubgraphByModelPoint(x: number, y: number) {
    const resolution = this.projection;
    if (!resolution) return "";

    return findMermaidGfxSubgraphIdByModelPoint(
      getMermaidGfxHitTestModels({
        elementIds: resolution.childElementIds,
        getModel: resolution.getElementById,
      }),
      x,
      y,
    );
  }

  findSubgraphHeaderByModelPoint(x: number, y: number) {
    const resolution = this.projection;
    if (!resolution) return "";

    return findMermaidGfxSubgraphHeaderIdByModelPoint(
      getMermaidGfxHitTestModels({
        elementIds: resolution.childElementIds,
        getModel: resolution.getElementById,
      }),
      x,
      y,
    );
  }

  findSubgraphCollapseByModelPoint(x: number, y: number) {
    const resolution = this.projection;
    if (!resolution) return "";
    return findMermaidGfxSubgraphCollapseIdByModelPoint(
      getMermaidGfxHitTestModels({
        elementIds: resolution.childElementIds,
        getModel: resolution.getElementById,
      }),
      x,
      y,
    );
  }

  findEdgeByModelPoint(
    visualModel: MermaidVisualModel | null,
    x: number,
    y: number,
  ) {
    if (!visualModel) return "";

    const resolution = this.projection;
    const connectors = resolution
      ? getMermaidGfxHitTestModels({
          elementIds: resolution.childElementIds,
          // The scoped connector manager computes the painted Page path. The
          // retained owner can carry an unpainted or obsolete route instead.
          getModel: (id) => this.getScopedModel(resolution.getElementById(id)),
        })
      : [];

    return findMermaidGfxEdgeIdByModelPoint({
      connectors,
      edges: visualModel.edges,
      nodes: [
        ...visualModel.nodes.map((node) => ({
          id: node.id,
          xywh: this.getNodeModel(node.id)?.xywh,
          hidden: !isMermaidGfxHitVisible(this.getNodeModel(node.id)),
        })),
        ...(typeOwnedMermaidEdgeHitTestIncludesSubgraphs(visualModel)
          ? (visualModel.subgraphs ?? []).map((subgraph) => ({
              id: subgraph.id,
              xywh: this.getSubgraphModel(subgraph.id)?.xywh,
            }))
          : []),
      ],
      x,
      y,
    });
  }

  findNodeByClientPoint(clientX: number, clientY: number) {
    const model = this.findNodeModelByClientPoint(clientX, clientY);
    return model ? getMermaidGfxSelectionIdentity(model).nodeId : "";
  }

  findConnectionTargetByClientPoint(clientX: number, clientY: number) {
    const nodeId = this.findNodeByClientPoint(clientX, clientY);
    if (nodeId) return nodeId;
    const visual = getMermaidVisualModel(this.host.getModel());
    if (!visual || !typeOwnedMermaidConnectionTargetsIncludeSubgraphs(visual))
      return "";
    const rect = this.getViewportElement()?.getBoundingClientRect();
    if (
      !rect ||
      clientX < rect.left ||
      clientX > rect.right ||
      clientY < rect.top ||
      clientY > rect.bottom
    )
      return "";
    const point = this.getModelPointFromClient(clientX, clientY);
    return point ? this.findSubgraphHeaderByModelPoint(point.x, point.y) : "";
  }

  findNodeModelByClientPoint(clientX: number, clientY: number) {
    const viewportElement = this.getViewportElement();
    if (viewportElement instanceof HTMLElement) {
      const rect = viewportElement.getBoundingClientRect();
      if (
        clientX < rect.left ||
        clientX > rect.right ||
        clientY < rect.top ||
        clientY > rect.bottom
      ) {
        return null;
      }
    }
    const gfx = this.getController();
    const point = this.getModelPointFromClient(clientX, clientY);
    if (point && gfx?.getElementByPoint) {
      const hits = gfx.getElementByPoint(point.x, point.y, {
        all: true,
        hitThreshold: 10,
      });
      const model = findMermaidGfxNodeModelFromNativeHits<{
        id?: string;
        text?: unknown;
        type?: string;
        xywh?: string;
      }>(hits);
      if (model) return model;
    }

    if (!point) return null;
    const resolution = this.projection;
    if (!resolution) return null;
    return findMermaidGfxNodeModelByModelPoint<{
      id?: string;
      text?: unknown;
      type?: string;
      xywh?: string;
    }>(
      getMermaidGfxHitTestModels({
        elementIds: resolution.childElementIds,
        getModel: resolution.getElementById,
      }),
      point.x,
      point.y,
    );
  }

  getManagedNodeModel(nodeId: string) {
    const resolution = this.projection;
    if (!resolution) return null;

    return findMermaidGfxNodeModelByVisualId({
      elementIds: resolution.childElementIds,
      getModel: (id) =>
        resolution.getElementById(id) as
          | {
              id?: string;
              text?: unknown;
              type?: string;
              xywh?: string;
            }
          | null
          | undefined,
      includeHelperNodes: true,
      nodeId,
    });
  }

  getNodeModel(nodeId: string) {
    if (this.hiddenObjectKeys.has(nodeId)) return null;
    return this.getScopedModel(this.getManagedNodeModel(nodeId));
  }

  getManagedEdgeModel(edgeId: string) {
    const resolution = this.projection;
    if (!resolution) return null;

    return findMermaidGfxEdgeModelByVisualId({
      edgeId,
      elementIds: resolution.childElementIds,
      getModel: (id) =>
        resolution.getElementById(id) as
          | {
              id?: string;
              labelXYWH?: readonly [number, number, number, number];
              type?: string;
              xywh?: string;
            }
          | null
          | undefined,
    });
  }

  getEdgeModel(edgeId: string) {
    if (this.hiddenObjectKeys.has(edgeId)) return null;
    return this.getScopedModel(this.getManagedEdgeModel(edgeId));
  }

  getEdgeLabelViewPoint(edgeId: string) {
    const labelXYWH = this.getEdgeModel(edgeId)?.labelXYWH;
    if (!labelXYWH) return null;
    return this.toViewPoint(
      labelXYWH[0] + labelXYWH[2] / 2,
      labelXYWH[1] + labelXYWH[3] / 2,
    );
  }

  getManagedSubgraphModel(subgraphId: string): ShapeElementModel | null {
    const resolution = this.projection;
    if (!resolution) return null;

    return findMermaidGfxSubgraphModelByVisualId({
      elementIds: resolution.childElementIds,
      getModel: (id) =>
        resolution.getElementById(id) as ShapeElementModel | null | undefined,
      subgraphId,
    });
  }

  getSubgraphModel(subgraphId: string) {
    return this.getScopedModel(this.getManagedSubgraphModel(subgraphId));
  }

  private isDenseLabelNode(model: MermaidNodeHandleModel) {
    return readMermaidGfxMeta(model, "mermaidNodeDenseLabel") === "true";
  }

  getNodeHandleViewPoints(
    model: MermaidNodeHandleModel,
    connectionPorts?: readonly MermaidGfxNodeConnectionPort[],
  ) {
    if (!model.xywh) return null;
    return mermaidGfxNodeHandleViewPoints({
      connectionPorts,
      denseLabelNode: this.isDenseLabelNode(model),
      diagramType: this.diagramType,
      toViewPoint: (x, y) => this.toViewPoint(x, y),
      xywh: model.xywh,
    });
  }

  getModelViewRect(xywh: string) {
    const bound = Bound.deserialize(xywh);
    const topLeft = this.toViewPoint(bound.x, bound.y);
    const bottomRight = this.toViewPoint(bound.x + bound.w, bound.y + bound.h);
    if (!topLeft || !bottomRight) return null;
    return {
      height: Math.max(0, bottomRight.top - topLeft.top),
      left: topLeft.left,
      top: topLeft.top,
      width: Math.max(0, bottomRight.left - topLeft.left),
    };
  }

  getSubgraphResizeHandleViewPoint(xywh: string) {
    return mermaidGfxSubgraphResizeHandleViewPoint({
      toViewPoint: (x, y) => this.toViewPoint(x, y),
      xywh,
    });
  }

  getSubgraphMoveHandleViewRect(xywh: string) {
    return mermaidGfxSubgraphMoveHandleViewRect({
      toViewPoint: (x, y) => this.toViewPoint(x, y),
      xywh,
    });
  }

  getEdgeHandleViewPoints({
    sourcePosition,
    sourceXywh,
    targetPosition,
    targetXywh,
  }: {
    sourcePosition?: readonly [number, number];
    sourceXywh: string;
    targetPosition?: readonly [number, number];
    targetXywh: string;
  }) {
    return mermaidGfxEdgeHandleViewPoints({
      diagramType: this.diagramType,
      sourcePosition,
      sourceXywh,
      targetPosition,
      targetXywh,
      toViewPoint: (x, y) => this.toViewPoint(x, y),
    });
  }
}
