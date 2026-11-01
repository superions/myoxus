// SPDX-License-Identifier: AGPL-3.0-or-later

import { html } from "lit";
import { styleMap } from "lit/directives/style-map.js";

import { mermaidMessages } from "../../i18n.js";
import type {
  MermaidGfxConnectionPreview,
  MermaidGfxEdgeReconnectEndpoint,
} from "../../mermaid-gfx-connection.js";

type MermaidGfxKeyboardHandler = (event: KeyboardEvent) => void;
type MermaidGfxPointerHandler = (event: PointerEvent) => void;
type MermaidGfxPoint = { readonly left: number; readonly top: number };
type MermaidGfxPort = MermaidGfxPoint & {
  readonly id: string;
  readonly position: readonly [number, number];
};
type MermaidGfxRect = MermaidGfxPoint & {
  readonly height: number;
  readonly width: number;
};

export type MermaidGfxAlignmentGuideProjection = {
  readonly direction: "column" | "row";
  readonly id: string;
  readonly members: readonly string[];
  readonly points: readonly MermaidGfxPoint[];
};

export function renderMermaidGfxAlignmentGuides({
  displayOnly,
  guides,
  onSelect,
}: {
  displayOnly: boolean;
  guides: readonly MermaidGfxAlignmentGuideProjection[];
  onSelect: (guideId: string, memberIds: readonly string[]) => void;
}) {
  if (displayOnly || guides.length === 0) return null;
  return html`<div class="myoxus-mermaid-gfx-alignment-guides">
    ${guides.map((guide) => {
      const first = guide.points[0];
      const last = guide.points.at(-1);
      if (!first || !last) return null;
      const left = Math.min(first.left, last.left);
      const top = Math.min(first.top, last.top);
      const width = Math.abs(last.left - first.left);
      const height = Math.abs(last.top - first.top);
      return html`<div
          aria-hidden="true"
          class="myoxus-mermaid-gfx-alignment-guide"
          data-alignment-direction=${guide.direction}
          data-alignment-id=${guide.id}
          style=${styleMap({
            height: `${Math.max(height, 1)}px`,
            left: `${left}px`,
            top: `${top}px`,
            width: `${Math.max(width, 1)}px`,
          })}
        ></div>
        <button
          aria-label=${
            guide.direction === "row"
              ? mermaidMessages.architectureAlignRow()
              : mermaidMessages.architectureAlignColumn()
          }
          aria-keyshortcuts="Enter Space"
          class="myoxus-mermaid-gfx-alignment-anchor"
          data-alignment-direction=${guide.direction}
          data-alignment-id=${guide.id}
          @click=${(event: MouseEvent) => {
            event.preventDefault();
            event.stopPropagation();
            onSelect(guide.id, guide.members);
          }}
          style=${styleMap({
            left: `${(first.left + last.left) / 2}px`,
            top: `${(first.top + last.top) / 2}px`,
          })}
          type="button"
        ></button>`;
    })}
  </div>`;
}

export function renderMermaidGfxSelectionChrome({
  bounds,
  count,
  items,
}: {
  bounds: MermaidGfxRect | null;
  count: number;
  items: ReadonlyArray<
    MermaidGfxRect & {
      readonly id: string;
      readonly kind: "edge" | "node" | "subgraph";
    }
  >;
}) {
  if (items.length === 0) return null;
  return html`<div
    aria-hidden="true"
    class="myoxus-mermaid-gfx-selection-chrome"
  >
    ${items.map(
      (item) =>
        html`<div
          class="myoxus-mermaid-gfx-selection-outline"
          data-node-id=${item.kind === "node" ? item.id : undefined}
          data-selection-id=${item.id}
          data-selection-kind=${item.kind}
          style=${styleMap({
            height: `${item.height}px`,
            left: `${item.left}px`,
            top: `${item.top}px`,
            width: `${item.width}px`,
          })}
        ></div>`,
    )}
    ${
      bounds && count > 1
        ? html`<div
            class="myoxus-mermaid-gfx-selection-bounds"
            style=${styleMap({
              height: `${bounds.height}px`,
              left: `${bounds.left}px`,
              top: `${bounds.top}px`,
              width: `${bounds.width}px`,
            })}
          >
            <span>${mermaidMessages.pageSelectionCount(count)}</span>
          </div>`
        : null
    }
  </div>`;
}
type MermaidGfxEdgeHandlePoints = {
  readonly source: MermaidGfxPoint;
  readonly target: MermaidGfxPoint;
};

function connectionPreviewPath(preview: MermaidGfxConnectionPreview) {
  const { source, sourcePosition, target, targetPosition } = preview;
  if (!preview.validTarget || !sourcePosition || !targetPosition) {
    return `M ${source.left} ${source.top} L ${target.left} ${target.top}`;
  }
  const sourceHorizontal = sourcePosition[0] === 0 || sourcePosition[0] === 1;
  const targetHorizontal = targetPosition[0] === 0 || targetPosition[0] === 1;
  if (sourceHorizontal && targetHorizontal) {
    const middleX = (source.left + target.left) / 2;
    return `M ${source.left} ${source.top} H ${middleX} V ${target.top} H ${target.left}`;
  }
  if (!sourceHorizontal && !targetHorizontal) {
    const middleY = (source.top + target.top) / 2;
    return `M ${source.left} ${source.top} V ${middleY} H ${target.left} V ${target.top}`;
  }
  return sourceHorizontal
    ? `M ${source.left} ${source.top} H ${target.left} V ${target.top}`
    : `M ${source.left} ${source.top} V ${target.top} H ${target.left}`;
}

function connectionPortIndicator(position: readonly [number, number]) {
  if (position[0] === 0.5 && position[1] === 0) return "↑";
  if (position[0] === 1 && position[1] === 0.5) return "→";
  if (position[0] === 0.5 && position[1] === 1) return "↓";
  if (position[0] === 0 && position[1] === 0.5) return "←";
  return "•";
}

export function renderMermaidGfxConnectionPreview({
  displayOnly,
  preview,
}: {
  displayOnly: boolean;
  preview: MermaidGfxConnectionPreview | null;
}) {
  if (displayOnly || !preview) return null;
  return html`<svg
      class="myoxus-mermaid-gfx-connection-preview"
      aria-hidden="true"
      data-valid-target=${preview.validTarget ? "true" : "false"}
    >
      <path d=${connectionPreviewPath(preview)}></path>
      <circle
        class="myoxus-mermaid-gfx-connection-preview-source"
        cx=${preview.source.left}
        cy=${preview.source.top}
        r="4"
      ></circle>
      <circle
        class="myoxus-mermaid-gfx-connection-preview-target"
        cx=${preview.target.left}
        cy=${preview.target.top}
        r=${preview.validTarget ? "6" : "4"}
      ></circle>
    </svg>
    ${
      preview.validTarget
        ? null
        : html`<div
            class="myoxus-mermaid-gfx-connection-diagnostic"
            role="status"
            style=${styleMap({
              left: `${preview.target.left}px`,
              top: `${preview.target.top}px`,
            })}
          >
            ${mermaidMessages.visualConnectionInvalidTarget()}
          </div>`
    }`;
}

export function renderMermaidGfxNodeConnectHandles({
  disabled,
  displayOnly,
  handles,
  hasSelectedNode,
  onKeydown,
  onPointerDown,
}: {
  disabled: boolean;
  displayOnly: boolean;
  handles: readonly MermaidGfxPort[];
  hasSelectedNode: boolean;
  onKeydown: (event: KeyboardEvent, portId: string) => void;
  onPointerDown: (event: PointerEvent, portId: string) => void;
}) {
  if (displayOnly || !hasSelectedNode || handles.length === 0) return null;
  return handles.map(
    (handle) =>
      html`<button
        aria-keyshortcuts="ArrowUp ArrowRight ArrowDown ArrowLeft"
        class="myoxus-mermaid-gfx-connect-handle"
        type="button"
        aria-label=${`${mermaidMessages.visualConnectorHandle()} ${connectionPortIndicator(handle.position)}`}
        data-port-id=${handle.id}
        data-port-x=${handle.position[0]}
        data-port-y=${handle.position[1]}
        title=${`${mermaidMessages.visualConnectorHandle()} ${connectionPortIndicator(handle.position)}`}
        style=${styleMap({
          left: `${handle.left}px`,
          top: `${handle.top}px`,
        })}
        ?disabled=${disabled}
        @keydown=${(event: KeyboardEvent) => onKeydown(event, handle.id)}
        @pointerdown=${(event: PointerEvent) => onPointerDown(event, handle.id)}
      ></button>`,
  );
}

export function renderMermaidGfxNodeResizeHandle({
  disabled,
  displayOnly,
  handle,
  hasSelectedNode,
  onKeydown,
  onPointerDown,
}: {
  disabled: boolean;
  displayOnly: boolean;
  handle: MermaidGfxPoint | null;
  hasSelectedNode: boolean;
  onKeydown: MermaidGfxKeyboardHandler;
  onPointerDown: MermaidGfxPointerHandler;
}) {
  if (displayOnly || !hasSelectedNode || !handle) return null;
  return html`<button
    aria-keyshortcuts="ArrowUp ArrowRight ArrowDown ArrowLeft"
    class="myoxus-mermaid-gfx-resize-handle"
    type="button"
    aria-label=${mermaidMessages.visualResizeNode()}
    title=${mermaidMessages.visualResizeNode()}
    style=${styleMap({
      left: `${handle.left}px`,
      top: `${handle.top}px`,
    })}
    ?disabled=${disabled}
    @keydown=${onKeydown}
    @pointerdown=${onPointerDown}
  ></button>`;
}

export function renderMermaidGfxEdgeReconnectHandles({
  disabled,
  displayOnly,
  handles,
  hasSelectedEdge,
  onKeydown,
  onPointerDown,
}: {
  disabled: boolean;
  displayOnly: boolean;
  handles: MermaidGfxEdgeHandlePoints | null;
  hasSelectedEdge: boolean;
  onKeydown: (
    event: KeyboardEvent,
    endpoint: MermaidGfxEdgeReconnectEndpoint,
  ) => void;
  onPointerDown: (
    event: PointerEvent,
    endpoint: MermaidGfxEdgeReconnectEndpoint,
  ) => void;
}) {
  if (displayOnly || !hasSelectedEdge || !handles) return null;
  return html`<button
      aria-keyshortcuts="ArrowUp ArrowRight ArrowDown ArrowLeft"
      class="myoxus-mermaid-gfx-edge-handle"
      data-endpoint="source"
      type="button"
      aria-label=${mermaidMessages.visualReconnectSource()}
      title=${mermaidMessages.visualReconnectSource()}
      style=${styleMap({
        left: `${handles.source.left}px`,
        top: `${handles.source.top}px`,
      })}
      ?disabled=${disabled}
      @keydown=${(event: KeyboardEvent) => onKeydown(event, "source")}
      @pointerdown=${(event: PointerEvent) => onPointerDown(event, "source")}
    ></button>
    <button
      aria-keyshortcuts="ArrowUp ArrowRight ArrowDown ArrowLeft"
      class="myoxus-mermaid-gfx-edge-handle"
      data-endpoint="target"
      type="button"
      aria-label=${mermaidMessages.visualReconnectTarget()}
      title=${mermaidMessages.visualReconnectTarget()}
      style=${styleMap({
        left: `${handles.target.left}px`,
        top: `${handles.target.top}px`,
      })}
      ?disabled=${disabled}
      @keydown=${(event: KeyboardEvent) => onKeydown(event, "target")}
      @pointerdown=${(event: PointerEvent) => onPointerDown(event, "target")}
    ></button>`;
}

export function renderMermaidGfxContextMenu({
  canShow,
  label,
  left,
  onClick,
  onStopEvent,
  top,
}: {
  canShow: boolean;
  label: string;
  left: number;
  onClick: () => void;
  onStopEvent: (event: Event) => void;
  top: number;
}) {
  if (!canShow) return null;
  return html`<div
    class="myoxus-mermaid-gfx-context-menu"
    role="menu"
    aria-label=${mermaidMessages.visualContextMenu()}
    style=${styleMap({
      left: `${left}px`,
      top: `${top}px`,
    })}
    @click=${onStopEvent}
    @pointerdown=${onStopEvent}
  >
    <button type="button" role="menuitem" @click=${onClick}>${label}</button>
  </div>`;
}

export function renderMermaidGfxSubgraphResizeHandle({
  disabled,
  displayOnly,
  handle,
  hasSelectedSubgraph,
  onKeydown,
  onPointerDown,
}: {
  disabled: boolean;
  displayOnly: boolean;
  handle: MermaidGfxPoint | null;
  hasSelectedSubgraph: boolean;
  onKeydown: MermaidGfxKeyboardHandler;
  onPointerDown: MermaidGfxPointerHandler;
}) {
  if (displayOnly || !hasSelectedSubgraph || !handle) return null;
  return html`<button
    aria-keyshortcuts="ArrowUp ArrowRight ArrowDown ArrowLeft"
    class="myoxus-mermaid-gfx-subgraph-resize-handle"
    type="button"
    aria-label=${mermaidMessages.visualResizeSubgraph()}
    title=${mermaidMessages.visualResizeSubgraph()}
    style=${styleMap({
      left: `${handle.left}px`,
      top: `${handle.top}px`,
    })}
    ?disabled=${disabled}
    @keydown=${onKeydown}
    @pointerdown=${onPointerDown}
  ></button>`;
}

export function renderMermaidGfxSubgraphDropPreview({
  displayOnly,
  preview,
}: {
  displayOnly: boolean;
  preview: (MermaidGfxRect & { readonly id: string }) | null;
}) {
  if (displayOnly || !preview) return null;
  return html`<div
    aria-hidden="true"
    class="myoxus-mermaid-gfx-subgraph-drop-preview"
    data-subgraph-id=${preview.id}
    style=${styleMap({
      height: `${preview.height}px`,
      left: `${preview.left}px`,
      top: `${preview.top}px`,
      width: `${preview.width}px`,
    })}
  ></div>`;
}

export function renderMermaidGfxSubgraphMoveHandle({
  disabled,
  displayOnly,
  handle,
  hasSelectedSubgraph,
  onKeydown,
  onPointerDown,
}: {
  disabled: boolean;
  displayOnly: boolean;
  handle: MermaidGfxRect | null;
  hasSelectedSubgraph: boolean;
  onKeydown: MermaidGfxKeyboardHandler;
  onPointerDown: MermaidGfxPointerHandler;
}) {
  if (displayOnly || !hasSelectedSubgraph || !handle) return null;
  return html`<button
    aria-keyshortcuts="ArrowUp ArrowRight ArrowDown ArrowLeft"
    class="myoxus-mermaid-gfx-subgraph-move-handle"
    type="button"
    aria-label=${mermaidMessages.visualMoveSubgraph()}
    title=${mermaidMessages.visualMoveSubgraph()}
    style=${styleMap({
      height: `${handle.height}px`,
      left: `${handle.left}px`,
      top: `${handle.top}px`,
      width: `${handle.width}px`,
    })}
    ?disabled=${disabled}
    @keydown=${onKeydown}
    @pointerdown=${onPointerDown}
  ></button>`;
}

export function renderMermaidGfxViewportResizeHandle({
  disabled,
  displayOnly,
  onKeydown,
  onPointerDown,
}: {
  disabled: boolean;
  displayOnly: boolean;
  onKeydown: MermaidGfxKeyboardHandler;
  onPointerDown: MermaidGfxPointerHandler;
}) {
  if (displayOnly) return null;
  return html`<div class="myoxus-mermaid-viewport-resize-row">
    <button
      class="myoxus-mermaid-viewport-resize-handle"
      type="button"
      aria-label=${mermaidMessages.visualResizeViewport()}
      title=${mermaidMessages.visualResizeViewport()}
      ?disabled=${disabled}
      @keydown=${onKeydown}
      @pointerdown=${onPointerDown}
    ></button>
  </div>`;
}
