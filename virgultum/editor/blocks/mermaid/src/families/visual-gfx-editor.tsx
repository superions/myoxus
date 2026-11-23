// SPDX-License-Identifier: AGPL-3.0-or-later

import { ViewExtensionManagerIdentifier } from "@virgultum/core/extensions";
import { Bound, type SerializedXYWH } from "@virgultum/core/primitives/gfx";
import { DefaultTool } from "@virgultum/canvas-runtime/surface";
import {
  ThemeExtensionIdentifier,
  ThemeProvider,
  ViewportElementExtension,
} from "@virgultum/core/services";
import { BlockStdScope } from "@virgultum/core/runtime";
import { GfxControllerIdentifier } from "@virgultum/core/runtime/gfx";
import type { ExtensionType, Store } from "@virgultum/core/store";
import {
  type CSSProperties,
  type ReactNode,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { MermaidEditorShellProjection } from "./runtime/editor-capabilities.js";
import { MermaidFamilyReactHostIdentifier } from "./runtime/react-host.js";

import type { MermaidVisualModel } from "./runtime/gfx-model.js";
import { MermaidEdgelessOwnerGfxSync } from "../presentation/edgeless-owner-gfx-sync.js";
import type { MermaidGfxProjection } from "../presentation/gfx-projection-owner.js";
import { MermaidEmbeddedChildVisibility } from "../presentation/embedded-child-visibility.js";
import {
  MERMAID_SCOPED_GFX_DISPLAY_MIN_VIEWPORT_HEIGHT,
  MERMAID_SCOPED_GFX_PAGE_MAX_VIEWPORT_HEIGHT,
  MERMAID_SCOPED_GFX_PAGE_MIN_VIEWPORT_HEIGHT,
} from "../mermaid-block-constants.js";
import type { MermaidGfxConnectionPreview } from "../mermaid-gfx-connection.js";
import type { MermaidGfxEdgeReconnectEndpoint } from "../mermaid-gfx-connection.js";
import { mermaidMessages } from "../i18n.js";
import {
  createMermaidScopedGfxEditorExtension,
  MERMAID_SCOPED_GFX_PAGE_MIN_READABLE_ZOOM,
  MERMAID_SCOPED_GFX_VIEWPORT_PADDING,
} from "../scoped-gfx-editor.js";
import { calculateMermaidVisualViewportHeight } from "../mermaid-gfx-viewport.js";
import type { MermaidGfxEditorState } from "./runtime/gfx-editor-state.js";
import type { MermaidPageViewportProjection } from "../mermaid-page-viewport-state.js";
import { mountMermaidPageDraggingArea } from "../mermaid-page-dragging-area.js";
import { MermaidPageSelectionTool } from "../mermaid-page-selection-tool.js";
import type { MermaidPageSelectionToolsContribution } from "./runtime/contracts.js";
import type { MermaidPageSelectionOperation } from "../mermaid-page-selection-controller.js";
import {
  renderMermaidGfxConnectionPreview,
  renderMermaidGfxAlignmentGuides,
  renderMermaidGfxContextMenu,
  renderMermaidGfxEdgeReconnectHandles,
  renderMermaidGfxNodeConnectHandles,
  renderMermaidGfxNodeResizeHandle,
  renderMermaidGfxSelectionChrome,
  renderMermaidGfxSubgraphMoveHandle,
  renderMermaidGfxSubgraphDropPreview,
  renderMermaidGfxSubgraphResizeHandle,
  renderMermaidGfxViewportResizeHandle,
} from "./runtime/gfx-editor-overlays.js";
import type { MermaidGfxAlignmentGuideProjection } from "./runtime/gfx-editor-overlays.js";
import { typeOwnedMermaidMinimumReadableZoom } from "./runtime/gfx-owner-hooks.js";

type MermaidGfxViewPoint = { readonly left: number; readonly top: number };
type MermaidGfxViewPort = MermaidGfxViewPoint & {
  readonly id: string;
  readonly position: readonly [number, number];
};
type MermaidGfxViewRect = MermaidGfxViewPoint & {
  readonly height: number;
  readonly width: number;
};

type MermaidGfxEdgeHandlePoints = {
  readonly source: MermaidGfxViewPoint;
  readonly target: MermaidGfxViewPoint;
};

type MermaidGfxDomListener = EventListenerOrEventListenerObject;

function MermaidScopedCanvas({
  createScope,
  showDragArea,
}: {
  createScope: () => BlockStdScope;
  showDragArea: boolean;
}) {
  const anchor = useRef<HTMLDivElement>(null);
  const [mount] = useState(() => createScope);
  useLayoutEffect(() => {
    const scope = mount();
    const session = scope.mountCanvas(anchor.current!);
    const stopDragArea = showDragArea
      ? mountMermaidPageDraggingArea(
          session.host,
          scope.get(GfxControllerIdentifier),
        )
      : undefined;
    return () => {
      stopDragArea?.();
      session.dispose();
    };
  }, [mount, showDragArea]);
  return <div ref={anchor} style={{ display: "contents" }} />;
}

export type MermaidGfxPageEditorVisualState = {
  readonly alignmentGuides: readonly MermaidGfxAlignmentGuideProjection[];
  readonly connectionPreview: MermaidGfxConnectionPreview | null;
  readonly contextMenu: {
    readonly left: number;
    readonly top: number;
  } | null;
  readonly contextMenuLabel: string;
  readonly edgeReconnectHandles: MermaidGfxEdgeHandlePoints | null;
  readonly keyboardFocusRect: MermaidGfxViewRect | null;
  readonly keyboardObjectFocused: boolean;
  readonly nodeConnectHandles: readonly MermaidGfxViewPort[];
  readonly nodeResizeHandle: MermaidGfxViewPoint | null;
  readonly showContextMenu: boolean;
  readonly selectionAnnouncement: string;
  readonly selectionBounds: MermaidGfxViewRect | null;
  readonly selectionRects: ReadonlyArray<
    MermaidGfxViewRect & {
      readonly id: string;
      readonly kind: "edge" | "node" | "subgraph";
    }
  >;
  readonly subgraphMoveHandle: MermaidGfxViewRect | null;
  readonly subgraphDropPreview:
    (MermaidGfxViewRect & { readonly id: string }) | null;
  readonly subgraphResizeHandle: MermaidGfxViewPoint | null;
};

export type MermaidGfxPageEditorHandlers = {
  readonly onAlignmentGuideSelect: (
    guideId: string,
    memberIds: readonly string[],
  ) => void;
  readonly resolvePageSelectedItems: () => ReadonlyArray<{
    readonly editKey: string;
    readonly kind: "edge" | "node" | "subgraph";
  }>;
  readonly onConnectorHandleKeydown: (
    event: KeyboardEvent,
    portId: string,
  ) => void;
  readonly onConnectorHandlePointerDown: (
    event: PointerEvent,
    portId: string,
  ) => void;
  readonly onContextConnect: () => void;
  readonly onCloseContextMenu: () => void;
  readonly onEdgeReconnectKeydown: (
    event: KeyboardEvent,
    endpoint: MermaidGfxEdgeReconnectEndpoint,
  ) => void;
  readonly onEdgeReconnectPointerDown: (
    event: PointerEvent,
    endpoint: MermaidGfxEdgeReconnectEndpoint,
  ) => void;
  readonly onProjectionOwnerSelection: (elementIds: string[]) => void;
  readonly onProjectionOwnerSurfaceMutation: () => void;
  readonly onProjectionOwnerViewportFit: () => void;
  readonly onProjectionOwnerViewportInteraction: () => void;
  readonly onProjectionOwnerViewportMove: () => void;
  readonly onProjectionOwnerViewportReady: () => void;
  readonly onNodeResizeKeydown: (event: KeyboardEvent) => void;
  readonly onNodeResizePointerDown: (event: PointerEvent) => void;
  readonly onDetailSelect?: (ownerKey: string, detailKey: string) => void;
  readonly onDetailEdit?: (ownerKey: string, detailKey: string) => void;
  readonly onObjectFocus: (item: {
    readonly editKey: string;
    readonly kind: "edge" | "node" | "subgraph";
  }) => void;
  readonly onObjectKeydown: (
    event: KeyboardEvent,
    item: {
      readonly editKey: string;
      readonly kind: "edge" | "node" | "subgraph";
    },
  ) => void;
  readonly onPageSelectionGestureChange: (active: boolean) => void;
  readonly onPageSelectionProjectionReady: () => void;
  readonly onPageSelectionOperation: (
    operation: MermaidPageSelectionOperation,
    baseIds: readonly string[],
    candidateIds: readonly string[],
  ) => void;
  readonly onStopEditorEvent: (event: Event) => void;
  readonly onSubgraphMoveKeydown: (event: KeyboardEvent) => void;
  readonly onSubgraphMovePointerDown: (event: PointerEvent) => void;
  readonly onSubgraphResizeKeydown: (event: KeyboardEvent) => void;
  readonly onSubgraphResizePointerDown: (event: PointerEvent) => void;
  readonly onViewportClick: MermaidGfxDomListener;
  readonly onViewportContextMenu: MermaidGfxDomListener;
  readonly onViewportDoubleClick: MermaidGfxDomListener;
  readonly onViewportFocus: MermaidGfxDomListener;
  readonly onViewportFocusOut: MermaidGfxDomListener;
  readonly onViewportPointerDown: MermaidGfxDomListener;
  readonly onViewportResizeKeydown: (
    event: KeyboardEvent,
    viewportHeight: number,
  ) => void;
  readonly onViewportResizePointerDown: (
    event: PointerEvent,
    viewportHeight: number,
  ) => void;
};

/**
 * Render the owner-backed scoped editor shell.
 *
 * The block host still owns lifecycle, commands and active pointer sessions.
 * This module owns only the scoped GFX viewport, connection/resize handles and
 * display-only wiring. Family actions are projected separately by the owning
 * capability into the common React shell; an embedded capability may opt into
 * that Facade surface without adopting Page viewport state.
 */
export function renderMermaidGfxPageEditor({
  displayOnly = false,
  embedded = false,
  embeddedEditing = false,
  gfxStore,
  handlers,
  inspector,
  isViewportUserPositioned,
  projectShell,
  projectionOwnerStateKey,
  pendingShape,
  pageViewport,
  pageSelectionTools,
  resolvePageSelectionTool,
  resolveViewportPadding,
  readonly,
  resolution,
  resolveFrameXYWH,
  resolveVisualModel,
  subscribeVisualModelChange,
  resolveViewportHeight,
  std,
  visualModel,
  visualState,
  keyboardSelectionItems = [],
  keyboardDetailItems = [],
}: {
  readonly displayOnly?: boolean;
  readonly embedded?: boolean;
  readonly embeddedEditing?: boolean;
  readonly gfxStore: Store;
  readonly handlers: MermaidGfxPageEditorHandlers;
  readonly inspector: MermaidGfxEditorState;
  readonly keyboardDetailItems?: readonly {
    ownerKey: string;
    detailKey: string;
    label: string;
  }[];
  readonly keyboardSelectionItems?: ReadonlyArray<{
    readonly editKey: string;
    readonly kind: "edge" | "node" | "subgraph";
    readonly label: string;
  }>;
  readonly isViewportUserPositioned: () => boolean;
  readonly projectShell?: (
    workarea: ReactNode,
    workareaFooter: ReactNode,
  ) => MermaidEditorShellProjection;
  readonly projectionOwnerStateKey: string;
  readonly pendingShape: MermaidVisualModel["nodes"][number]["shape"] | null;
  readonly pageViewport: MermaidPageViewportProjection;
  readonly pageSelectionTools?: MermaidPageSelectionToolsContribution;
  readonly readonly: boolean;
  readonly resolution: MermaidGfxProjection;
  readonly resolveFrameXYWH: () => SerializedXYWH;
  readonly resolvePageSelectionTool?: () => "box" | "pointer";
  readonly resolveViewportPadding: () => [number, number, number, number];
  readonly resolveVisualModel: () => MermaidVisualModel;
  readonly subscribeVisualModelChange: (onChange: () => void) => () => void;
  readonly resolveViewportHeight: (autoViewportHeight: number) => number;
  readonly std: BlockStdScope;
  readonly visualModel: MermaidVisualModel;
  readonly visualState: MermaidGfxPageEditorVisualState;
}) {
  const viewExtensionManager = std.get(ViewExtensionManagerIdentifier);
  const minimumReadableZoom = typeOwnedMermaidMinimumReadableZoom(
    visualModel,
    MERMAID_SCOPED_GFX_PAGE_MIN_READABLE_ZOOM,
  );
  const previewExtensions = viewExtensionManager.get("preview-edgeless");
  const themeSignal = std.get(ThemeProvider).theme$;
  const scopedTheme: ExtensionType = {
    setup(di) {
      // The inner scope has only a Surface root. Inherit the resolved outer
      // editor theme instead of mistaking that scope for a Document Page.
      di.override(ThemeExtensionIdentifier, () => ({
        getAppTheme: () => themeSignal,
        getEdgelessTheme: () => themeSignal,
      }));
    },
  };
  // Every editable Document Page GFX family uses the same scoped pointer
  // owner. Family capabilities only decide whether its additional box mode is
  // exposed. Embedded Edgeless keeps its existing capability-driven tool.
  const useScopedPagePointerTool =
    !readonly && (!embedded || Boolean(pageSelectionTools));
  const extensions = [
    // The block host owns owner source sync and visual history for this scoped
    // consumer in Page and an opened Edgeless Note. The document-wide Edgeless
    // owner must run only for a native root consumer; mounting both would replay
    // one shortcut twice.
    // The scoped selection specialization also replaces the default tool.
    ...previewExtensions.filter(
      (extension) =>
        extension !== MermaidEdgelessOwnerGfxSync &&
        extension !== MermaidEmbeddedChildVisibility &&
        (!useScopedPagePointerTool || extension !== DefaultTool),
    ),
    scopedTheme,
    ViewportElementExtension(".myoxus-mermaid-gfx-viewport"),
    ...(useScopedPagePointerTool ? [MermaidPageSelectionTool] : []),
    createMermaidScopedGfxEditorExtension({
      allowedElementIds: resolution.childElementIds,
      callbacks: {
        ...(readonly
          ? {}
          : {
              onSelectionChange: handlers.onProjectionOwnerSelection,
              onPageSelectionGestureChange:
                handlers.onPageSelectionGestureChange,
              onPageSelectionProjectionReady:
                handlers.onPageSelectionProjectionReady,
              onPageSelectionOperation: handlers.onPageSelectionOperation,
              onSurfaceMutation: handlers.onProjectionOwnerSurfaceMutation,
            }),
        onViewportFit: handlers.onProjectionOwnerViewportFit,
        onViewportInteraction: handlers.onProjectionOwnerViewportInteraction,
        onViewportMove: handlers.onProjectionOwnerViewportMove,
        onViewportReady: handlers.onProjectionOwnerViewportReady,
      },
      editable: !readonly,
      enableViewportNavigation: embedded && embeddedEditing,
      frameXYWH: resolution.ownerXYWH,
      // View owns a fresh fitted presentation camera. An interaction in the
      // editable viewport must not suppress the display viewport's initial fit.
      // The persisted diagram geometry remains shared; only the camera state is
      // intentionally mode-local.
      isViewportUserPositioned: displayOnly
        ? () => false
        : isViewportUserPositioned,
      minReadableZoom: minimumReadableZoom,
      ownerId: resolution.ownerId,
      retainAutomaticViewportFit: embedded && readonly && !embeddedEditing,
      resolveFrameXYWH,
      // Passive Notes and explicit Page Auto fit the complete diagram. Opened
      // Notes retain their readable camera and use native navigation for overflow.
      resolveMinimumReadableZoom: () =>
        (embedded && readonly && !embeddedEditing) ||
        (!embedded && pageViewport.state.zoom === "auto")
          ? null
          : typeOwnedMermaidMinimumReadableZoom(
              resolveVisualModel(),
              MERMAID_SCOPED_GFX_PAGE_MIN_READABLE_ZOOM,
            ),
      // Embedded Edgeless is a fitted projection of the owner's persisted
      // geometry. Page alone owns the interactive Page zoom/scroll state.
      resolvePageZoom: () => (embedded ? "auto" : pageViewport.state.zoom),
      resolveViewportPadding,
      resolvePageSelectableItems:
        !readonly && pageSelectionTools
          ? () =>
              pageSelectionTools
                .resolveItems(resolveVisualModel())
                .filter(
                  (item) =>
                    item.boxSelectable !== false &&
                    pageSelectionTools.boxSelectableKinds.includes(item.kind),
                )
          : undefined,
      resolvePageSelectedItems:
        !readonly && pageSelectionTools
          ? handlers.resolvePageSelectedItems
          : undefined,
      resolvePageSelectionTool: useScopedPagePointerTool
        ? resolvePageSelectionTool
        : undefined,
      resolveVisualModel,
      subscribeVisualModelChange,
      visualModel,
      viewportPadding: MERMAID_SCOPED_GFX_VIEWPORT_PADDING,
    }),
  ];
  const theme = themeSignal.value;
  const ownerBound = Bound.deserialize(resolution.ownerXYWH);
  const [paddingTop, paddingRight, paddingBottom, paddingLeft] =
    resolveViewportPadding();
  // The nested GFX camera preserves readable physical text under the outer
  // Note transform. Its auto-height must reserve those same physical bounds
  // in local CSS space, including the already measured action inset.
  const outerZoom =
    embedded && embeddedEditing
      ? std.get(GfxControllerIdentifier).viewport.zoom
      : 1;
  const viewScale = Number.isFinite(outerZoom) && outerZoom > 0 ? outerZoom : 1;
  const autoViewportHeight = calculateMermaidVisualViewportHeight(
    ownerBound.h / viewScale,
    displayOnly
      ? MERMAID_SCOPED_GFX_DISPLAY_MIN_VIEWPORT_HEIGHT
      : MERMAID_SCOPED_GFX_PAGE_MIN_VIEWPORT_HEIGHT,
    MERMAID_SCOPED_GFX_PAGE_MAX_VIEWPORT_HEIGHT,
    paddingTop / viewScale,
    paddingBottom / viewScale,
    minimumReadableZoom,
  );
  const viewportHeight = resolveViewportHeight(autoViewportHeight);
  const naturalContentWidth = ownerBound.w + paddingLeft + paddingRight;
  const naturalContentHeight = ownerBound.h + paddingTop + paddingBottom;

  const bindViewport = (anchor: HTMLDivElement | null) => {
    if (!anchor) return;
    const lifetime = new AbortController();
    const options = { signal: lifetime.signal, capture: true };
    anchor.addEventListener("click", handlers.onViewportClick, options);
    anchor.addEventListener("focusin", handlers.onViewportFocus, options);
    anchor.addEventListener("focusout", handlers.onViewportFocusOut, options);
    if (!readonly) {
      anchor.addEventListener(
        "contextmenu",
        handlers.onViewportContextMenu,
        options,
      );
      anchor.addEventListener(
        "dblclick",
        handlers.onViewportDoubleClick,
        options,
      );
      if (resolvePageSelectionTool?.() !== "box")
        anchor.addEventListener(
          "pointerdown",
          handlers.onViewportPointerDown,
          options,
        );
    }
    return () => lifetime.abort();
  };
  const scopeKey = JSON.stringify([
    resolution.ownerId,
    resolution.childElementIds,
    projectionOwnerStateKey,
    readonly,
    embeddedEditing,
  ]);
  const workarea = (
    <div
      className="myoxus-mermaid-gfx-editor"
      data-diagram-type={visualModel.diagramType}
      data-mermaid-display-mode={displayOnly ? "display" : "edit"}
      data-mermaid-gfx-editable={readonly ? "false" : "true"}
      data-mermaid-gfx-surface="true"
      data-inserting-shape={pendingShape ? "true" : "false"}
      data-mermaid-owner-id={resolution.ownerId}
      data-mermaid-page-natural-height={naturalContentHeight}
      data-mermaid-page-natural-width={naturalContentWidth}
      style={
        {
          "--myoxus-mermaid-gfx-viewport-height": `${viewportHeight}px`,
        } as CSSProperties
      }
    >
      <div
        aria-label={
          visualModel.accessibilityTitle || mermaidMessages.visualEditorLabel()
        }
        aria-description={visualModel.accessibilityDescription || undefined}
        role={
          visualModel.accessibilityTitle || visualModel.accessibilityDescription
            ? "group"
            : undefined
        }
        className="myoxus-mermaid-gfx-viewport myoxus-edgeless-viewport"
        data-theme={theme}
        ref={bindViewport}
        tabIndex={
          keyboardSelectionItems.length === 0 ||
          visualState.keyboardObjectFocused
            ? -1
            : 0
        }
      >
        <div className="myoxus-mermaid-inline-mount-point myoxus-mermaid-inline-shape-editor-layer"></div>
        <MermaidScopedCanvas
          key={scopeKey}
          showDragArea={useScopedPagePointerTool && Boolean(pageSelectionTools)}
          createScope={() => new BlockStdScope({ extensions, store: gfxStore })}
        />
        {renderMermaidGfxConnectionPreview({
          displayOnly,
          preview: visualState.connectionPreview,
        })}
        {renderMermaidGfxAlignmentGuides({
          displayOnly,
          guides: visualState.alignmentGuides,
          onSelect: handlers.onAlignmentGuideSelect,
        })}
        {displayOnly || readonly
          ? null
          : renderMermaidGfxSelectionChrome({
              bounds: visualState.selectionBounds,
              count: visualState.selectionRects.length,
              items: visualState.selectionRects,
            })}
        {renderMermaidGfxNodeConnectHandles({
          disabled: readonly,
          displayOnly,
          handles: visualState.nodeConnectHandles,
          hasSelectedNode: Boolean(inspector.selectedNode),
          onKeydown: handlers.onConnectorHandleKeydown,
          onPointerDown: handlers.onConnectorHandlePointerDown,
        })}
        {renderMermaidGfxNodeResizeHandle({
          disabled: readonly,
          displayOnly,
          handle: visualState.nodeResizeHandle,
          hasSelectedNode: Boolean(inspector.selectedNode),
          onKeydown: handlers.onNodeResizeKeydown,
          onPointerDown: handlers.onNodeResizePointerDown,
        })}
        {renderMermaidGfxEdgeReconnectHandles({
          disabled: readonly,
          displayOnly,
          handles: visualState.edgeReconnectHandles,
          hasSelectedEdge: Boolean(inspector.selectedEdge),
          onKeydown: handlers.onEdgeReconnectKeydown,
          onPointerDown: handlers.onEdgeReconnectPointerDown,
        })}
        {renderMermaidGfxContextMenu({
          canShow: !readonly && visualState.showContextMenu,
          renderMenu: std.getOptional(MermaidFamilyReactHostIdentifier)
            ?.renderContextMenu,
          close: handlers.onCloseContextMenu,
          label: visualState.contextMenuLabel,
          left: visualState.contextMenu?.left ?? 0,
          onClick: handlers.onContextConnect,
          top: visualState.contextMenu?.top ?? 0,
        })}
        {renderMermaidGfxSubgraphDropPreview({
          displayOnly,
          preview: visualState.subgraphDropPreview,
        })}
        {renderMermaidGfxSubgraphMoveHandle({
          disabled: readonly,
          displayOnly,
          handle: visualState.subgraphMoveHandle,
          hasSelectedSubgraph: Boolean(inspector.selectedSubgraph),
          onKeydown: handlers.onSubgraphMoveKeydown,
          onPointerDown: handlers.onSubgraphMovePointerDown,
        })}
        {renderMermaidGfxSubgraphResizeHandle({
          disabled: readonly,
          displayOnly,
          handle: visualState.subgraphResizeHandle,
          hasSelectedSubgraph: Boolean(inspector.selectedSubgraph),
          onKeydown: handlers.onSubgraphResizeKeydown,
          onPointerDown: handlers.onSubgraphResizePointerDown,
        })}
        {visualState.keyboardFocusRect ? (
          <div
            aria-hidden="true"
            className="myoxus-mermaid-gfx-keyboard-focus-outline"
            style={{
              height: `${visualState.keyboardFocusRect.height}px`,
              left: `${visualState.keyboardFocusRect.left}px`,
              top: `${visualState.keyboardFocusRect.top}px`,
              width: `${visualState.keyboardFocusRect.width}px`,
            }}
          ></div>
        ) : null}
        {keyboardSelectionItems.length === 0
          ? null
          : keyboardSelectionItems.map((node) => (
              <button
                aria-label={node.label || node.editKey}
                aria-keyshortcuts="Enter Space"
                key={node.editKey}
                className="myoxus-mermaid-gfx-object-focus-proxy"
                data-mermaid-edit-key={node.editKey}
                data-object-kind={node.kind}
                type="button"
                onClick={(event) =>
                  handlers.onStopEditorEvent?.(event.nativeEvent)
                }
                onFocus={() => handlers.onObjectFocus(node)}
                onKeyDown={(event) =>
                  ((event: KeyboardEvent) =>
                    handlers.onObjectKeydown(event, node))?.(event.nativeEvent)
                }
              ></button>
            ))}
        {keyboardDetailItems.map((detail) => (
          <button
            aria-label={detail.label}
            aria-keyshortcuts="Enter Space"
            key={detail.detailKey}
            className="myoxus-mermaid-gfx-object-focus-proxy"
            data-object-kind="detail"
            data-mermaid-edit-key={detail.detailKey}
            type="button"
            onClick={(event) => handlers.onStopEditorEvent?.(event.nativeEvent)}
            onFocus={() => {
              handlers.onObjectFocus({
                editKey: detail.ownerKey,
                kind: "node",
              });
              handlers.onDetailSelect?.(detail.ownerKey, detail.detailKey);
            }}
            onKeyDown={(event) =>
              ((event: KeyboardEvent) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                event.stopPropagation();
                handlers.onDetailEdit?.(detail.ownerKey, detail.detailKey);
              })?.(event.nativeEvent)
            }
          ></button>
        ))}
        {keyboardSelectionItems.length ? (
          <div
            aria-live="polite"
            aria-atomic="true"
            className="myoxus-mermaid-gfx-selection-live-region"
          >
            {visualState.selectionAnnouncement}
          </div>
        ) : null}
      </div>
    </div>
  );
  const workareaFooter =
    embedded || readonly ? null : (
      <>
        {renderMermaidGfxViewportResizeHandle({
          disabled: readonly,
          displayOnly,
          onKeydown: (event) =>
            handlers.onViewportResizeKeydown(event, viewportHeight),
          onPointerDown: (event) =>
            handlers.onViewportResizePointerDown(event, viewportHeight),
        })}
      </>
    );

  return (
    projectShell?.(workarea, workareaFooter) ?? {
      actions: null,
      body: (
        <>
          {workarea}
          {workareaFooter}
        </>
      ),
    }
  );
}
