import {
  EdgelessCRUDIdentifier,
  normalizeWheelDeltaY,
} from "@virgultum/block-surface";
import { DisposableGroup } from "@virgultum/global/disposable";
import { Bound, Point, type SerializedXYWH } from "@virgultum/global/gfx";
import { EditorSettingProvider } from "@virgultum/shared/services";
import { isTouchPadPinchEvent } from "@virgultum/shared/utils";
import { LifeCycleWatcher, SurfaceSelection } from "@virgultum/std";
import { GfxControllerIdentifier } from "@virgultum/std/gfx";
import type { ExtensionType } from "@virgultum/store";
import * as Y from "yjs";

import { toMermaidShapeElementProps } from "./families/runtime/gfx-element-projection.js";
import {
  MERMAID_GFX_EDGE_ROLE,
  MERMAID_GFX_NODE_ROLE,
  MERMAID_GFX_SUBGRAPH_ROLE,
} from "./families/runtime/gfx-element-roles.js";
import type {
  MermaidVisualEdge,
  MermaidVisualModel,
  MermaidVisualNodeShape,
} from "./families/runtime/gfx-model.js";
import {
  parseMermaidVisualFamilyData,
  serializeMermaidVisualFamilyData,
} from "./families/runtime/gfx-family-data.js";
import {
  finalizeTypeOwnedMermaidAdoptedNodeElementProps,
  typeOwnedMermaidNodeElementProjection,
} from "./families/runtime/gfx-owner-hooks.js";
import {
  createMermaidGfxVisualEdge,
  createMermaidGfxVisualNode,
} from "./families/runtime/gfx-graph-operations.js";
import { cloneMermaidVisualModel } from "./mermaid-visual-model-operations.js";
import type { MermaidPageZoom } from "./mermaid-page-viewport-state.js";
import type { MermaidPageSelectionTool as MermaidPageSelectionToolMode } from "./mermaid-page-selection-state.js";
import { MermaidPageSelectionTool } from "./mermaid-page-selection-tool.js";
import type { MermaidPageSelectionOperation } from "./mermaid-page-selection-controller.js";
import {
  readMermaidGfxEdgeId,
  readMermaidGfxMeta,
  readMermaidGfxNodeId,
  readMermaidGfxRole,
  readMermaidGfxSubgraphId,
  writeMermaidGfxMeta,
} from "./mermaid-gfx-metadata.js";
import { projectMermaidLocalGfxAppearance } from "./mermaid-local-gfx-appearance.js";
import { MERMAID_INLINE_NODE_EDITOR_CLASS } from "./mermaid-editor-events.js";

export type MermaidScopedGfxEditorCallbacks = {
  onPageSelectionGestureChange?: (active: boolean) => void;
  onPageSelectionProjectionReady?: () => void;
  onPageSelectionOperation?: (
    operation: MermaidPageSelectionOperation,
    baseIds: readonly string[],
    candidateIds: readonly string[],
  ) => void;
  onSelectionChange?: (elementIds: string[]) => void;
  onSurfaceMutation?: () => void;
  onViewportFit?: () => void;
  onViewportInteraction?: () => void;
  onViewportMove?: () => void;
  onViewportReady?: () => void;
};

export const MERMAID_SCOPED_GFX_VIEWPORT_PADDING = [36, 36, 36, 36] satisfies [
  number,
  number,
  number,
  number,
];

export const MERMAID_SCOPED_GFX_PAGE_MIN_READABLE_ZOOM = 0.5;

export function fitMermaidReadablePageViewport({
  bound,
  minReadableZoom,
  padding,
  viewport,
}: {
  bound: Bound;
  minReadableZoom: number | null;
  padding: [number, number, number, number];
  viewport: {
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
  };
}) {
  if (minReadableZoom === null) {
    viewport.setViewportByBound?.(bound, padding);
    return;
  }

  const [pt, pr, pb, pl] = padding;
  const fitZoom = Math.min(
    (viewport.width - (pr + pl)) / bound.w,
    (viewport.height - (pt + pb)) / bound.h,
  );
  if (
    !Number.isFinite(fitZoom) ||
    fitZoom >= minReadableZoom ||
    !viewport.setViewport
  ) {
    viewport.setViewportByBound?.(bound, padding);
    return;
  }

  const zoom = minReadableZoom;
  const visibleModelWidth = viewport.width / zoom;
  const visibleModelHeight = viewport.height / zoom;
  const fitsHorizontally = bound.w * zoom <= viewport.width - (pl + pr);
  const fitsVertically = bound.h * zoom <= viewport.height - (pt + pb);
  const centerX = fitsHorizontally
    ? bound.x + (bound.w + pr / zoom) / 2 - pl / zoom / 2
    : bound.x + visibleModelWidth / 2 - pl / zoom;
  const centerY = fitsVertically
    ? bound.y + (bound.h + pb / zoom) / 2 - pt / zoom / 2
    : bound.y + visibleModelHeight / 2 - pt / zoom;

  viewport.setViewport(zoom, [centerX, centerY], false, true);
}

export function createMermaidScopedGfxEditorExtension({
  allowedElementIds,
  callbacks,
  editable = true,
  enableViewportNavigation = false,
  frameXYWH,
  isViewportUserPositioned = () => false,
  minReadableZoom = MERMAID_SCOPED_GFX_PAGE_MIN_READABLE_ZOOM,
  ownerId,
  retainAutomaticViewportFit = false,
  resolveFrameXYWH = () => frameXYWH,
  resolveMinimumReadableZoom = () => minReadableZoom,
  resolvePageZoom = () => "auto",
  resolveViewportPadding = () => viewportPadding,
  resolvePageSelectableItems,
  resolvePageSelectedItems,
  resolvePageSelectionTool,
  visualModel,
  resolveVisualModel = () => visualModel,
  subscribeVisualModelChange,
  viewportPadding = MERMAID_SCOPED_GFX_VIEWPORT_PADDING,
}: {
  allowedElementIds: readonly string[];
  callbacks?: MermaidScopedGfxEditorCallbacks;
  editable?: boolean;
  /** Opened Notes have no Edgeless root to own wheel camera navigation. */
  enableViewportNavigation?: boolean;
  frameXYWH: SerializedXYWH;
  isViewportUserPositioned?: () => boolean;
  minReadableZoom?: number | null;
  ownerId: string;
  retainAutomaticViewportFit?: boolean;
  resolveFrameXYWH?: () => SerializedXYWH;
  resolveMinimumReadableZoom?: () => number | null;
  resolvePageZoom?: () => MermaidPageZoom;
  resolveViewportPadding?: () => [number, number, number, number];
  resolvePageSelectableItems?: () => ReadonlyArray<{
    readonly editKey: string;
    readonly kind: string;
  }>;
  resolvePageSelectedItems?: () => ReadonlyArray<{
    readonly editKey: string;
    readonly kind: string;
  }>;
  resolvePageSelectionTool?: () => MermaidPageSelectionToolMode;
  resolveVisualModel?: () => MermaidVisualModel;
  subscribeVisualModelChange?: (onChange: () => void) => () => void;
  visualModel: MermaidVisualModel;
  viewportPadding?: [number, number, number, number];
}): ExtensionType {
  const allowed = new Set(allowedElementIds);

  class MermaidScopedGfxEditorHost extends LifeCycleWatcher {
    static override readonly key = `mermaid-scoped-gfx-editor:${ownerId}`;

    private readonly _disposables = new DisposableGroup();
    private _filteringSelection = false;
    private _lastViewportFitKey = "";
    private _lastAppliedFixedZoom: number | null = null;
    private _refreshViewportRaf = 0;
    private readonly _refreshViewportTimers = new Set<
      ReturnType<typeof setTimeout>
    >();

    private _clearRefreshViewportQueue() {
      if (this._refreshViewportRaf) {
        cancelAnimationFrame(this._refreshViewportRaf);
        this._refreshViewportRaf = 0;
      }
      for (const timer of this._refreshViewportTimers) {
        clearTimeout(timer);
      }
      this._refreshViewportTimers.clear();
    }

    override mounted() {
      const gfx = this.std.get(GfxControllerIdentifier);
      const crud = this.std.get(EdgelessCRUDIdentifier);
      const currentBound = () => Bound.deserialize(resolveFrameXYWH());
      if (resolvePageSelectionTool) {
        const pageTool = gfx.tool.get(MermaidPageSelectionTool);
        pageTool.configure({
          onGestureChange: (active) =>
            callbacks?.onPageSelectionGestureChange?.(active),
          onSelectionOperation: (operation, baseIds, candidateIds) =>
            callbacks?.onPageSelectionOperation?.(
              operation,
              baseIds,
              candidateIds,
            ),
          resolveMode: resolvePageSelectionTool,
          resolveSelectedIds: () => {
            const selectedKeys = new Set(
              (resolvePageSelectedItems?.() ?? []).map(
                (item) => `${item.kind}\u0000${item.editKey}`,
              ),
            );
            return gfx.gfxElements.flatMap((model) => {
              if (!allowed.has(model.id)) return [];
              const role = readMermaidGfxRole(model);
              const key =
                role === MERMAID_GFX_NODE_ROLE
                  ? `node\u0000${readMermaidGfxNodeId(model)}`
                  : role === MERMAID_GFX_EDGE_ROLE
                    ? `edge\u0000${readMermaidGfxEdgeId(model)}`
                    : role === MERMAID_GFX_SUBGRAPH_ROLE
                      ? `subgraph\u0000${readMermaidGfxSubgraphId(model)}`
                      : "";
              return key && selectedKeys.has(key) ? [model.id] : [];
            });
          },
          resolveOrderedSelectableIds: () => {
            if (!resolvePageSelectableItems) return [];
            const gfxIdBySelectionItem = new Map<string, string>();
            for (const model of gfx.gfxElements) {
              if (!allowed.has(model.id)) continue;
              const role = readMermaidGfxRole(model);
              const item =
                role === MERMAID_GFX_NODE_ROLE
                  ? { editKey: readMermaidGfxNodeId(model), kind: "node" }
                  : role === MERMAID_GFX_EDGE_ROLE
                    ? { editKey: readMermaidGfxEdgeId(model), kind: "edge" }
                    : role === MERMAID_GFX_SUBGRAPH_ROLE
                      ? {
                          editKey: readMermaidGfxSubgraphId(model),
                          kind: "subgraph",
                        }
                      : null;
              if (!item?.editKey) continue;
              const key = `${item.kind}\u0000${item.editKey}`;
              if (!gfxIdBySelectionItem.has(key)) {
                gfxIdBySelectionItem.set(key, model.id);
              }
            }
            return resolvePageSelectableItems()
              .map(
                (item) =>
                  gfxIdBySelectionItem.get(
                    `${item.kind}\u0000${item.editKey}`,
                  ) ?? "",
              )
              .filter(Boolean);
          },
        });
        gfx.tool.setTool(MermaidPageSelectionTool);
      }
      let acceptsAutomaticViewportRefresh = true;
      const visibleElementIds = new Set(allowed);
      const owner = this.std.store.getBlock(ownerId)?.model as
        | {
            addChildren?: (models: unknown[]) => void;
            childIds?: readonly string[];
            display?: boolean;
            flavour?: string;
          }
        | null
        | undefined;

      const getViewportFitKey = () => {
        return [
          resolveFrameXYWH(),
          // Keep the invalidation key on the same geometry snapshot consumed
          // by the fit below. In an embedded Edgeless Note the outer camera can
          // change getBoundingClientRect() before the nested GFX viewport has
          // refreshed its cached client rect. Mixing those two snapshots marks
          // the new size as fitted while fitting the old size, leaving dense
          // diagrams stuck at the global minimum zoom.
          Math.round(gfx.viewport.width),
          Math.round(gfx.viewport.height),
          ...resolveViewportPadding(),
        ].join(":");
      };
      const refreshViewport = (force = false) => {
        if (
          !acceptsAutomaticViewportRefresh ||
          (!force && isViewportUserPositioned())
        ) {
          return;
        }
        const pageZoom = resolvePageZoom();
        if (pageZoom !== "auto") {
          if (!force && this._lastAppliedFixedZoom === pageZoom) return;
          this._lastAppliedFixedZoom = pageZoom;
          const bound = currentBound();
          const scale = pageZoom / 100;
          const [pt, pr, pb, pl] = resolveViewportPadding();
          // Native Page scroll starts at zero. A centered overflowing camera
          // would put the first nodes at negative coordinates, beyond that
          // scroll range. Keep fixed zoom and start overflow at its leading edge.
          gfx.viewport.setViewport?.(
            scale,
            [
              bound.w * scale > gfx.viewport.width - pl - pr
                ? bound.x + (gfx.viewport.width / 2 - pl) / scale
                : bound.x + bound.w / 2,
              bound.h * scale > gfx.viewport.height - pt - pb
                ? bound.y + (gfx.viewport.height / 2 - pt) / scale
                : bound.y + bound.h / 2,
            ],
            false,
            true,
          );
          callbacks?.onViewportFit?.();
          return;
        }
        this._lastAppliedFixedZoom = null;
        const key = getViewportFitKey();
        if (!force && key === this._lastViewportFitKey) return;
        this._lastViewportFitKey = key;
        fitMermaidReadablePageViewport({
          bound: currentBound(),
          minReadableZoom: resolveMinimumReadableZoom(),
          padding: resolveViewportPadding(),
          viewport: gfx.viewport,
        });
        callbacks?.onViewportFit?.();
      };
      const scheduleViewportRefresh = (force = false) => {
        if (
          !acceptsAutomaticViewportRefresh ||
          (!force && isViewportUserPositioned())
        ) {
          return;
        }
        if (this._refreshViewportRaf) return;
        this._refreshViewportRaf = requestAnimationFrame(() => {
          this._refreshViewportRaf = 0;
          refreshViewport(force);
        });
      };
      const scheduleLateViewportRefreshes = () => {
        for (const delay of [50, 250]) {
          const timer = setTimeout(() => {
            this._refreshViewportTimers.delete(timer);
            scheduleViewportRefresh();
          }, delay);
          this._refreshViewportTimers.add(timer);
        }
      };
      let applyScopedVisibility = () => {};
      let viewportReadyProjected = false;
      const projectViewportReady = () => {
        applyScopedVisibility();
        if (viewportReadyProjected) return;
        viewportReadyProjected = true;
        callbacks?.onViewportReady?.();
      };
      // A new scope needs an initial camera even when the outgoing Page scope
      // was user-positioned. Its ready callback restores a retained camera;
      // later automatic fits still respect the user's navigation.
      scheduleViewportRefresh(true);
      if (!retainAutomaticViewportFit) scheduleLateViewportRefreshes();
      const viewportReadyRaf = requestAnimationFrame(projectViewportReady);
      this._disposables.add({
        dispose: () => cancelAnimationFrame(viewportReadyRaf),
      });
      const cancelAutomaticViewportRefresh = () => {
        // Late mount fits exist only to settle initial layout. Once the user
        // starts navigating or manipulating the canvas, that camera position
        // is authoritative and a delayed fit would be a visible jump.
        acceptsAutomaticViewportRefresh = false;
        this._clearRefreshViewportQueue();
        this._lastViewportFitKey = getViewportFitKey();
        callbacks?.onViewportInteraction?.();
      };
      if (enableViewportNavigation) {
        // The inherited preview scope locks its camera. An opened Note owns
        // an interactive camera; its passive projection stays locked.
        gfx.viewport.locked = false;
        const viewportElement = this.std.host.closest<HTMLElement>(
          ".myoxus-mermaid-gfx-viewport",
        );
        if (viewportElement) {
          const navigate = (event: WheelEvent) => {
            const { viewport } = gfx;
            if (viewport.locked) return;
            const input =
              event.target instanceof Element
                ? event.target.closest(
                    'input, textarea, select, [contenteditable="true"]',
                  )
                : null;
            if (input && viewportElement.contains(input)) return;
            event.preventDefault();
            event.stopPropagation();
            cancelAutomaticViewportRefresh();
            const scrollZoom = this.std
              .getOptional(EditorSettingProvider)
              ?.setting$.peek().edgelessScrollZoom;
            if (isTouchPadPinchEvent(event) || scrollZoom) {
              const rect = viewportElement.getBoundingClientRect();
              // Canvas rendering already compensates the outer Note scale.
              // Physical pointer deltas pass through the scoped zoom once.
              const anchor = new Point(
                viewport.viewportX +
                  (event.clientX - rect.left) / viewport.zoom,
                viewport.viewportY + (event.clientY - rect.top) / viewport.zoom,
              );
              viewport.setZoom(
                normalizeWheelDeltaY(event.deltaY, viewport.zoom),
                anchor,
                true,
              );
            } else {
              const horizontal = event.shiftKey && event.deltaX === 0;
              const dx =
                (horizontal ? event.deltaY : event.deltaX) / viewport.zoom;
              const dy = horizontal ? 0 : event.deltaY / viewport.zoom;
              viewport.applyDeltaCenter(dx, dy);
              viewport.viewportMoved.next([dx, dy]);
            }
          };
          viewportElement.addEventListener("wheel", navigate, {
            passive: false,
          });
          this._disposables.add(() =>
            viewportElement.removeEventListener("wheel", navigate),
          );
        }
      }
      if (!retainAutomaticViewportFit) {
        this.std.host.addEventListener(
          "pointerdown",
          cancelAutomaticViewportRefresh,
          { capture: true },
        );
        this.std.host.addEventListener(
          "wheel",
          cancelAutomaticViewportRefresh,
          { capture: true },
        );
        this._disposables.add({
          dispose: () => {
            this.std.host.removeEventListener(
              "pointerdown",
              cancelAutomaticViewportRefresh,
              { capture: true },
            );
            this.std.host.removeEventListener(
              "wheel",
              cancelAutomaticViewportRefresh,
              { capture: true },
            );
          },
        });
      }
      const viewportReadySub = gfx.viewport.elementReady.subscribe(() => {
        projectViewportReady();
        scheduleViewportRefresh();
      });
      this._disposables.add({
        dispose: () => viewportReadySub.unsubscribe(),
      });
      const viewportSizeSub = gfx.viewport.sizeUpdated.subscribe(() => {
        scheduleViewportRefresh();
        callbacks?.onViewportMove?.();
      });
      this._disposables.add({
        dispose: () => viewportSizeSub.unsubscribe(),
      });
      // Zoom and center updates share the same coordinate authority. Families
      // with local overlays must observe both after the renderer transform.
      const viewportMoveSub = gfx.viewport.viewportUpdated.subscribe(() => {
        callbacks?.onViewportMove?.();
      });
      this._disposables.add({
        dispose: () => viewportMoveSub.unsubscribe(),
      });
      if (editable) {
        const selectionSub = this.std.selection.slots.changed.subscribe(
          (selections) => {
            if (this._filteringSelection) return;

            let changed = false;
            const nextSelections = selections.map((selection) => {
              if (!selection.is(SurfaceSelection)) return selection;

              const elements = selection.elements.filter((id) =>
                allowed.has(id),
              );
              if (elements.length !== selection.elements.length) {
                changed = true;
                return this.std.selection.create(
                  SurfaceSelection,
                  selection.blockId,
                  elements,
                  elements.length > 0 && selection.editing,
                  selection.inoperable,
                );
              }

              return selection;
            });

            if (!changed) return;
            this._filteringSelection = true;
            this.std.selection.set(nextSelections);
            this._filteringSelection = false;
          },
        );
        this._disposables.add({
          dispose: () => selectionSub.unsubscribe(),
        });
        const gfxSelectionSub = gfx.selection.slots.updated.subscribe(() => {
          callbacks?.onSelectionChange?.(
            gfx.selection.selectedIds.filter((id) => allowed.has(id)),
          );
        });
        this._disposables.add({
          dispose: () => gfxSelectionSub.unsubscribe(),
        });
      }

      const surface = gfx.surface;
      if (!surface) return;
      let projectingLocalAppearance = false;
      const projectLocalAppearance = () => {
        if (projectingLocalAppearance) return;
        // The inline editor temporarily masks the Canvas caption. Reapplying
        // Source appearance here would unmask it beneath the transparent input.
        if (
          this.std.host
            .closest(".myoxus-mermaid-gfx-viewport")
            ?.querySelector(`.${MERMAID_INLINE_NODE_EDITOR_CLASS}`)
        )
          return;
        projectingLocalAppearance = true;
        try {
          projectMermaidLocalGfxAppearance({
            elements: gfx.gfxElements.filter((element) =>
              allowed.has(element.id),
            ),
            frameXYWH: resolveFrameXYWH(),
            visualModel: resolveVisualModel(),
          });
        } finally {
          projectingLocalAppearance = false;
        }
      };
      const getSurfaceComponent = () =>
        gfx.surfaceComponent as
          | {
              setLocallyExcludedElementIds?: (ids: ReadonlySet<string>) => void;
            }
          | null
          | undefined;
      applyScopedVisibility = () => {
        const excludedElementIds = new Set(
          gfx.gfxElements
            .filter((model) => !visibleElementIds.has(model.id))
            .map((model) => model.id),
        );
        if (owner) excludedElementIds.add(ownerId);
        getSurfaceComponent()?.setLocallyExcludedElementIds?.(
          excludedElementIds,
        );
      };
      applyScopedVisibility();
      projectLocalAppearance();
      // Local renderer properties mask shared Surface values. A Source-only
      // style edit must refresh those masks after the committing transaction,
      // even when no geometry changed and the scoped editor stays mounted.
      if (subscribeVisualModelChange) {
        let appearanceRefresh = 0;
        this._disposables.add(
          subscribeVisualModelChange(() => {
            if (appearanceRefresh) return;
            appearanceRefresh = requestAnimationFrame(() => {
              appearanceRefresh = 0;
              projectLocalAppearance();
            });
          }),
        );
        this._disposables.add(() => {
          if (appearanceRefresh) cancelAnimationFrame(appearanceRefresh);
        });
      }
      this._disposables.add({
        dispose: () =>
          getSurfaceComponent()?.setLocallyExcludedElementIds?.(new Set()),
      });

      const shouldAdopt = (id: string) => {
        if (allowed.has(id)) return false;
        const model = surface.getElementById(id) as
          | {
              type?: string;
              xywh?: string;
            }
          | null
          | undefined;
        if (!model || (model.type !== "shape" && model.type !== "connector")) {
          return false;
        }
        if (
          readMermaidGfxRole(model) ||
          readMermaidGfxNodeId(model) ||
          readMermaidGfxSubgraphId(model) ||
          readMermaidGfxEdgeId(model)
        ) {
          return false;
        }
        if (!model.xywh) return model.type === "connector";
        return Bound.deserialize(model.xywh).isIntersectWithBound(
          currentBound(),
        );
      };
      const currentVisualModel = (): MermaidVisualModel => {
        const bound = currentBound();
        const current = cloneMermaidVisualModel(resolveVisualModel());
        const nodesById = new Map(current.nodes.map((node) => [node.id, node]));
        for (const childId of owner?.childIds ?? []) {
          const child = surface.getElementById(childId) as
            | {
                xywh?: string;
                yMap?: { get?: (key: string) => unknown };
              }
            | null
            | undefined;
          const nodeId = String(child?.yMap?.get?.("mermaidNodeId") ?? "");
          if (!nodeId) continue;
          const childBound = child?.xywh
            ? Bound.deserialize(child.xywh)
            : new Bound(bound.x, bound.y, 170, 96);
          const existing = nodesById.get(nodeId);
          const node = {
            ...existing,
            familyData:
              parseMermaidVisualFamilyData(
                child?.yMap?.get?.("mermaidNodeFamilyData"),
              ) ?? existing?.familyData,
            height: childBound.h,
            id: nodeId,
            label: String(
              child?.yMap?.get?.("mermaidNodeLabel") ??
                existing?.label ??
                nodeId,
            ),
            shape: String(
              child?.yMap?.get?.("mermaidNodeShape") ??
                existing?.shape ??
                "rect",
            ) as MermaidVisualNodeShape,
            width: childBound.w,
            x: childBound.x - bound.x,
            y: childBound.y - bound.y,
          };
          nodesById.set(nodeId, node);
        }
        current.nodes = [...nodesById.values()];
        return current;
      };
      const ownerChildren = () =>
        (owner?.childIds ?? []).flatMap((childId) => {
          const child = surface.getElementById(childId);
          return child ? [child] : [];
        });
      const hasConflictingIdentity = (
        candidateElementId: string | undefined,
        readIdentity: (model: unknown) => string,
        identity: string,
      ) =>
        Boolean(
          identity &&
          ownerChildren().some(
            (child) =>
              child.id !== candidateElementId &&
              readIdentity(child) === identity,
          ),
        );
      const readEndpointIdentity = (model: unknown) =>
        readMermaidGfxNodeId(model) || readMermaidGfxSubgraphId(model);
      const readEdgeMermaidId = (model: unknown) =>
        readMermaidGfxMeta(model, "mermaidEdgeMermaidId");
      const hasConflictingSemanticIdentity = (
        candidateElementId: string | undefined,
        identity: string,
      ) =>
        hasConflictingIdentity(
          candidateElementId,
          (child) => readEndpointIdentity(child) || readEdgeMermaidId(child),
          identity,
        );
      const uniqueIdentity = (preferred: string, used: ReadonlySet<string>) => {
        if (!used.has(preferred)) return preferred;
        let suffix = 2;
        while (used.has(`${preferred}-${suffix}`)) suffix += 1;
        return `${preferred}-${suffix}`;
      };
      const usedSemanticIds = () =>
        new Set(
          ownerChildren().flatMap((child) => {
            const endpointId = readEndpointIdentity(child);
            const edgeMermaidId = readEdgeMermaidId(child);
            return [endpointId, edgeMermaidId].filter(Boolean);
          }),
        );
      const usedEdgeIds = () =>
        new Set(ownerChildren().map(readMermaidGfxEdgeId).filter(Boolean));
      const visualShapeFromGfxShape = (
        shapeType: string | undefined,
        radius: number | undefined,
      ): MermaidVisualNodeShape | undefined => {
        if (shapeType === "diamond") return "diamond";
        if (shapeType === "ellipse") return "circle";
        if (shapeType === "triangle") return "tri";
        if (shapeType === "rect" && (radius ?? 0) > 0) return "rounded";
        if (shapeType === "rect") return "rect";
        return undefined;
      };
      const normalizeAdoptedShape = (model: unknown) => {
        const bound = currentBound();
        const shape = model as
          | {
              radius?: number;
              id?: string;
              shapeType?: string;
              text?: Y.Text;
              xywh?: string;
              type?: string;
              yMap?: {
                get?: (key: string) => unknown;
                set?: (key: string, value: unknown) => void;
              };
            }
          | null
          | undefined;
        if (shape?.type !== "shape" || !shape.yMap?.set) return;
        const role = readMermaidGfxRole(shape);
        const existingNodeId = readMermaidGfxNodeId(shape);
        const existingSubgraphId = readMermaidGfxSubgraphId(shape);
        if (
          role &&
          role !== MERMAID_GFX_NODE_ROLE &&
          role !== MERMAID_GFX_SUBGRAPH_ROLE
        ) {
          return;
        }
        if (
          existingNodeId &&
          !hasConflictingSemanticIdentity(shape.id, existingNodeId)
        ) {
          return;
        }
        if (
          existingSubgraphId &&
          !hasConflictingSemanticIdentity(shape.id, existingSubgraphId)
        ) {
          return;
        }
        if (role === MERMAID_GFX_SUBGRAPH_ROLE || existingSubgraphId) {
          const used = usedSemanticIds();
          const nextSubgraphId = existingSubgraphId
            ? uniqueIdentity(existingSubgraphId, used)
            : (() => {
                let index = used.size + 1;
                while (used.has(`SG${index}`)) index += 1;
                return `SG${index}`;
              })();
          writeMermaidGfxMeta(shape, "mermaidSubgraphId", nextSubgraphId);
          return;
        }
        const sourceBound = shape.xywh
          ? Bound.deserialize(shape.xywh)
          : new Bound(bound.x, bound.y, 170, 96);
        const requestedShape = visualShapeFromGfxShape(
          shape.shapeType,
          shape.radius,
        );
        const currentModel = currentVisualModel();
        const copiedNode = existingNodeId
          ? currentModel.nodes.find((node) => node.id === existingNodeId)
          : undefined;
        const node = copiedNode
          ? {
              ...copiedNode,
              height: sourceBound.h,
              width: sourceBound.w,
              x: sourceBound.x - bound.x,
              y: sourceBound.y - bound.y,
            }
          : createMermaidGfxVisualNode(currentModel, requestedShape, {
              centerX: sourceBound.x - bound.x + sourceBound.w / 2,
              centerY: sourceBound.y - bound.y + sourceBound.h / 2,
            });
        if (!node) return;
        node.id = uniqueIdentity(node.id, usedSemanticIds());
        const text = shape.text?.toString();
        if (text) node.label = text;
        const updates = finalizeTypeOwnedMermaidAdoptedNodeElementProps(
          currentModel,
          shape,
          toMermaidShapeElementProps(
            node,
            bound,
            currentModel.direction,
            currentModel.diagramTitle,
            typeOwnedMermaidNodeElementProjection(currentModel, node),
          ),
        );
        if (!shape.text) {
          updates.text = new Y.Text();
          (updates.text as Y.Text).insert(0, node.label);
          shape.text = updates.text as Y.Text;
        }
        if (shape.id) {
          crud.updateElement(shape.id, updates);
        } else {
          Object.assign(shape, updates);
        }
      };
      const normalizeAdoptedConnector = (model: unknown) => {
        const connector = model as
          | {
              id?: string;
              source?: { id?: string };
              target?: { id?: string };
              type?: string;
              yMap?: {
                get?: (key: string) => unknown;
                set?: (key: string, value: unknown) => void;
              };
            }
          | null
          | undefined;
        if (connector?.type !== "connector" || !connector.yMap?.set) return;
        const existingEdgeId = readMermaidGfxEdgeId(connector);
        const existingMermaidId = readEdgeMermaidId(connector);
        const hasMermaidIdConflict = hasConflictingSemanticIdentity(
          connector.id,
          existingMermaidId,
        );
        if (
          existingEdgeId &&
          !hasConflictingIdentity(
            connector.id,
            readMermaidGfxEdgeId,
            existingEdgeId,
          ) &&
          !hasMermaidIdConflict
        ) {
          return;
        }
        const sourceElementId = connector.source?.id;
        const targetElementId = connector.target?.id;
        const sourceElement = sourceElementId
          ? (surface.getElementById(sourceElementId) as
              { yMap?: { get?: (key: string) => unknown } } | null | undefined)
          : null;
        const targetElement = targetElementId
          ? (surface.getElementById(targetElementId) as
              { yMap?: { get?: (key: string) => unknown } } | null | undefined)
          : null;
        normalizeAdoptedShape(sourceElement);
        normalizeAdoptedShape(targetElement);
        const sourceNodeId =
          readMermaidGfxNodeId(sourceElement) ||
          readMermaidGfxSubgraphId(sourceElement);
        const targetNodeId =
          readMermaidGfxNodeId(targetElement) ||
          readMermaidGfxSubgraphId(targetElement);
        const currentModel = currentVisualModel();
        const edge: MermaidVisualEdge | null = createMermaidGfxVisualEdge(
          currentModel,
          sourceNodeId,
          targetNodeId,
        );
        if (!edge) return;
        edge.id = uniqueIdentity(edge.id, usedEdgeIds());
        edge.mermaidId = hasMermaidIdConflict
          ? undefined
          : existingMermaidId || edge.mermaidId;
        writeMermaidGfxMeta(connector, "mermaidRole", MERMAID_GFX_EDGE_ROLE);
        writeMermaidGfxMeta(connector, "mermaidEdgeId", edge.id);
        writeMermaidGfxMeta(
          connector,
          "mermaidEdgeMermaidId",
          edge.mermaidId ?? "",
        );
        writeMermaidGfxMeta(connector, "mermaidEdgeLabel", edge.label);
        if (edge.familyData) {
          writeMermaidGfxMeta(
            connector,
            "mermaidEdgeFamilyData",
            serializeMermaidVisualFamilyData(edge.familyData),
          );
        }
        if (edge.connectorMode) {
          writeMermaidGfxMeta(
            connector,
            "mermaidEdgeConnectorMode",
            edge.connectorMode,
          );
        }
        if (edge.labelPlacement) {
          writeMermaidGfxMeta(
            connector,
            "mermaidEdgeLabelPlacement",
            edge.labelPlacement,
          );
        }
      };

      const adopt = (id: string) => {
        if (!shouldAdopt(id)) return false;
        const model = surface.getElementById(id);
        if (!model) return false;
        const role = readMermaidGfxRole(model);
        if (
          model.type === "shape" &&
          role &&
          role !== MERMAID_GFX_NODE_ROLE &&
          role !== MERMAID_GFX_SUBGRAPH_ROLE
        ) {
          return false;
        }
        normalizeAdoptedShape(model);
        normalizeAdoptedConnector(model);
        if (
          (model.type === "shape" && !readEndpointIdentity(model)) ||
          (model.type === "connector" && !readMermaidGfxEdgeId(model))
        ) {
          return false;
        }
        allowed.add(id);
        visibleElementIds.add(id);
        owner?.addChildren?.([model]);
        applyScopedVisibility();
        return true;
      };

      const notify = (id: string, local = true) => {
        if (projectingLocalAppearance) return;
        if (allowed.has(id)) {
          const model = surface.getElementById(id);
          if (model && !owner?.childIds?.includes(id)) {
            owner?.addChildren?.([model]);
          }
          visibleElementIds.add(id);
          applyScopedVisibility();
          if (local) callbacks?.onSurfaceMutation?.();
          return;
        }
        const adopted = adopt(id);
        if (!allowed.has(id) && !adopted) return;
        if (local) callbacks?.onSurfaceMutation?.();
      };
      if (editable) {
        this._disposables.add(
          surface.elementAdded.subscribe(({ id, local }) => notify(id, local)),
        );
        this._disposables.add(
          surface.elementUpdated.subscribe(({ id, local }) =>
            notify(id, local),
          ),
        );
        this._disposables.add(
          surface.elementRemoved.subscribe(({ id, local }) =>
            notify(id, local),
          ),
        );
      }
      this._disposables.add(
        surface.elementAdded.subscribe(({ id }) => {
          // The shared surface can gain children of another Mermaid owner
          // after this viewport mounts, including in a passive Note preview.
          applyScopedVisibility();
          if (allowed.has(id)) projectLocalAppearance();
        }),
      );
      this._disposables.add(
        surface.elementRemoved.subscribe(() => applyScopedVisibility()),
      );
      this._disposables.add(
        surface.elementUpdated.subscribe(({ id }) => {
          if (allowed.has(id)) projectLocalAppearance();
        }),
      );
      callbacks?.onPageSelectionProjectionReady?.();
    }

    override unmounted() {
      this._clearRefreshViewportQueue();
      this._disposables.dispose();
    }
  }

  return MermaidScopedGfxEditorHost;
}
