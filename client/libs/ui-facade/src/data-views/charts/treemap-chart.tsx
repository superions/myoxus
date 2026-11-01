// SPDX-License-Identifier: AGPL-3.0-or-later

import type { KeyboardEvent, PointerEvent, ReactNode } from "react";
import { useEffect, useMemo, useRef } from "react";

import { useResponsiveElementSize } from "../../responsive";
import {
  DataChartShell,
  localizedChartNumber,
  type DataChartValueFormatter,
} from "./chart-shell";
import {
  computeDataTreemapLayout,
  DATA_TREEMAP_SECTION_HEADER,
  type DataTreemapLayoutNodeInput,
} from "./treemap-layout";

export type DataTreemapNode = DataTreemapLayoutNodeInput & {
  readonly className?: string;
  readonly commentCount?: number;
  readonly appearance?: {
    readonly fill?: string;
    readonly stroke?: string;
    readonly text?: string;
  };
};

export type DataTreemapChartProps = {
  readonly ariaDescription?: string;
  readonly ariaLabel: string;
  readonly compact?: boolean;
  readonly data: readonly DataTreemapNode[];
  readonly diagramCommentCount?: number;
  readonly editor?: ReactNode;
  readonly editorNodeId?: string;
  readonly emptyAction?: ReactNode;
  readonly emptyLabel: string;
  readonly focusRequestKey?: string | number;
  readonly geometry?: {
    readonly diagramPadding: number;
    readonly nodeHeight: number;
    readonly nodeWidth: number;
    readonly padding: number;
    readonly showValues: boolean;
    readonly useMaxWidth: boolean;
  };
  readonly interactive?: boolean;
  readonly labels: {
    readonly className: string;
    readonly comments: (count: number) => string;
    readonly move: string;
  };
  readonly onEdit?: (id: string, field: "label" | "value") => void;
  readonly onOpenClass?: (id: string) => void;
  readonly onOpenComment?: (id: string) => void;
  readonly onOpenDiagramComment?: () => void;
  readonly onReparent?: (id: string, parentId: string) => void;
  readonly onSelect?: (id: string) => void;
  readonly readonly?: boolean;
  readonly selectedId?: string;
  readonly validParentIds?: readonly string[];
  readonly valueFormatter?: DataChartValueFormatter;
};

const DEFAULT_GEOMETRY = {
  diagramPadding: 8,
  nodeHeight: 40,
  nodeWidth: 100,
  padding: 10,
  showValues: true,
  useMaxWidth: true,
} as const;

function flattened(nodes: readonly DataTreemapNode[]): DataTreemapNode[] {
  return nodes.flatMap((node) => [node, ...flattened(node.children ?? [])]);
}

function textForWidth(value: string, width: number) {
  const limit = Math.max(2, Math.floor(width / 8));
  return value.length <= limit
    ? value
    : `${value.slice(0, Math.max(1, limit - 1))}…`;
}

/** Accessible single-SVG Treemap renderer; source commands remain in Core. */
export function DataTreemapChart({
  ariaDescription,
  ariaLabel,
  compact = false,
  data,
  diagramCommentCount = 0,
  editor,
  editorNodeId,
  emptyAction,
  emptyLabel,
  focusRequestKey,
  geometry = DEFAULT_GEOMETRY,
  interactive = true,
  labels,
  onEdit,
  onOpenClass,
  onOpenComment,
  onOpenDiagramComment,
  onReparent,
  onSelect,
  readonly = false,
  selectedId,
  validParentIds = [],
  valueFormatter = localizedChartNumber,
}: DataTreemapChartProps) {
  const rootRef = useRef<HTMLElement | null>(null);
  const pointer = useRef<
    | {
        readonly id: number;
        readonly nodeId: string;
        readonly x: number;
        readonly y: number;
        moved: boolean;
      }
    | undefined
  >(undefined);
  const { ref: surfaceRef, width: surfaceWidth } =
    useResponsiveElementSize<HTMLDivElement>();
  const requestedWidth = Math.max(1, geometry.nodeWidth * 10);
  const height = Math.max(1, geometry.nodeHeight * 10);
  const width =
    surfaceWidth > 0
      ? Math.max(
          1,
          geometry.useMaxWidth ? Math.floor(surfaceWidth) : requestedWidth,
        )
      : requestedWidth;
  const layoutInput = useMemo(() => {
    const convert = (node: DataTreemapNode): DataTreemapLayoutNodeInput => ({
      children: node.children?.map(convert),
      id: node.id,
      label: node.label,
      sourceOrder: node.sourceOrder,
      type: node.type,
      value: node.value,
    });
    return data.map(convert);
  }, [data]);
  const layout = useMemo(
    () =>
      computeDataTreemapLayout({
        data: layoutInput,
        diagramPadding: geometry.diagramPadding,
        width,
        height,
        padding: geometry.padding,
      }),
    [geometry.diagramPadding, geometry.padding, height, layoutInput, width],
  );
  const inputById = new Map(flattened(data).map((node) => [node.id, node]));
  const editorAnchor = editorNodeId
    ? layout.find((node) => node.id === editorNodeId)
    : undefined;
  useEffect(() => {
    if (!selectedId) return;
    rootRef.current
      ?.querySelector<SVGGElement>(
        `[data-chart-node-id="${CSS.escape(selectedId)}"]`,
      )
      ?.focus();
  }, [focusRequestKey, selectedId]);
  const keyboard = (event: KeyboardEvent<SVGGElement>, id: string) => {
    if (!interactive) return;
    if (event.key === "Enter") {
      event.preventDefault();
      onEdit?.(id, "label");
      return;
    }
    if (event.key === "F2") {
      event.preventDefault();
      onEdit?.(id, "label");
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      const root = layout.find((node) => node.parentId === null);
      if (root) onSelect?.(root.id);
      return;
    }
    if (!event.key.startsWith("Arrow")) return;
    event.preventDefault();
    const current = layout.find((node) => node.id === id);
    if (!current) return;
    const horizontal = event.key === "ArrowLeft" || event.key === "ArrowRight";
    const direction =
      event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1;
    const center = horizontal
      ? (current.x0 + current.x1) / 2
      : (current.y0 + current.y1) / 2;
    const next = layout
      .filter((candidate) => candidate.id !== id)
      .map((candidate) => {
        const axis = horizontal
          ? (candidate.x0 + candidate.x1) / 2
          : (candidate.y0 + candidate.y1) / 2;
        const cross = horizontal
          ? Math.abs(
              (candidate.y0 + candidate.y1 - current.y0 - current.y1) / 2,
            )
          : Math.abs(
              (candidate.x0 + candidate.x1 - current.x0 - current.x1) / 2,
            );
        return { candidate, distance: (axis - center) * direction, cross };
      })
      .filter(({ distance }) => distance > 0)
      .sort(
        (left, right) =>
          left.distance - right.distance || left.cross - right.cross,
      )[0]?.candidate;
    if (next) onSelect?.(next.id);
  };
  const targetAt = (clientX: number, clientY: number) =>
    document
      .elementFromPoint(clientX, clientY)
      ?.closest<SVGGElement>('[data-treemap-type="section"]')?.dataset
      .chartNodeId;
  return (
    <DataChartShell
      ariaDescription={ariaDescription}
      ariaLabel={ariaLabel}
      empty={data.length === 0}
      emptyAction={emptyAction}
      emptyLabel={emptyLabel}
      rootRef={rootRef}
      selectedId={selectedId}
      testId="data-treemap-chart"
    >
      <div
        className="myoxus-data-treemap-chart-surface"
        data-compact={compact || undefined}
        data-interactive={interactive || undefined}
        data-readonly={readonly || undefined}
        ref={surfaceRef}
      >
        <svg
          aria-label={ariaLabel}
          role={interactive ? "application" : "img"}
          viewBox={`0 0 ${width} ${height}`}
          onPointerMove={(event) => {
            const active = pointer.current;
            if (!active || active.id !== event.pointerId) return;
            if (
              Math.hypot(event.clientX - active.x, event.clientY - active.y) > 4
            ) {
              active.moved = true;
              if (!event.currentTarget.hasPointerCapture(event.pointerId))
                event.currentTarget.setPointerCapture(event.pointerId);
            }
            const target = targetAt(event.clientX, event.clientY);
            if (target && validParentIds.includes(target))
              event.currentTarget.dataset.reparentTargetId = target;
            else delete event.currentTarget.dataset.reparentTargetId;
          }}
          onPointerUp={(event) => {
            const active = pointer.current;
            if (!active || active.id !== event.pointerId) return;
            const target = targetAt(event.clientX, event.clientY);
            pointer.current = undefined;
            if (event.currentTarget.hasPointerCapture(event.pointerId))
              event.currentTarget.releasePointerCapture(event.pointerId);
            delete event.currentTarget.dataset.reparentTargetId;
            if (active.moved && target && validParentIds.includes(target))
              onReparent?.(active.nodeId, target);
          }}
          onPointerCancel={(event) => {
            if (pointer.current?.id !== event.pointerId) return;
            pointer.current = undefined;
            delete event.currentTarget.dataset.reparentTargetId;
          }}
        >
          {layout.map((node) => {
            const input = inputById.get(node.id);
            if (!input) return null;
            const width = Math.max(0, node.x1 - node.x0);
            const height = Math.max(0, node.y1 - node.y0);
            const selected = selectedId === node.id;
            return (
              <g
                aria-label={`${node.label}, ${valueFormatter(node.type === "leaf" ? node.value : node.aggregate)}`}
                aria-pressed={interactive ? selected : undefined}
                className="myoxus-data-treemap-node"
                data-chart-node-id={node.id}
                data-class-name={input.className}
                data-selected={selected || undefined}
                data-treemap-type={node.type}
                key={node.id}
                onClick={() => interactive && onSelect?.(node.id)}
                onDoubleClick={() => interactive && onEdit?.(node.id, "label")}
                onKeyDown={(event) => keyboard(event, node.id)}
                onPointerDown={(event: PointerEvent<SVGGElement>) => {
                  if (!interactive || readonly || !onReparent) return;
                  pointer.current = {
                    id: event.pointerId,
                    nodeId: node.id,
                    x: event.clientX,
                    y: event.clientY,
                    moved: false,
                  };
                }}
                role={interactive ? "button" : undefined}
                tabIndex={interactive ? 0 : undefined}
                transform={`translate(${node.x0},${node.y0})`}
              >
                <title>{node.label}</title>
                <rect
                  className={
                    node.type === "section"
                      ? "myoxus-data-treemap-section"
                      : "myoxus-data-treemap-leaf"
                  }
                  height={height}
                  style={{
                    fill: input.appearance?.fill,
                    stroke: input.appearance?.stroke,
                  }}
                  width={width}
                />
                <text
                  className="myoxus-data-treemap-label"
                  onDoubleClick={(event) => {
                    event.stopPropagation();
                    if (interactive && !readonly) onEdit?.(node.id, "label");
                  }}
                  x={node.type === "section" ? 8 : width / 2}
                  y={
                    node.type === "section"
                      ? DATA_TREEMAP_SECTION_HEADER / 2
                      : height / 2
                  }
                  textAnchor={node.type === "section" ? "start" : "middle"}
                  style={{ fill: input.appearance?.text }}
                >
                  {textForWidth(node.label, width - 16)}
                </text>
                {geometry.showValues && width > 54 && height > 28 ? (
                  <text
                    className="myoxus-data-treemap-value"
                    onClick={(event) => {
                      if (
                        !interactive ||
                        readonly ||
                        node.type !== "leaf" ||
                        !onEdit
                      )
                        return;
                      event.stopPropagation();
                      onEdit(node.id, "value");
                    }}
                    onDoubleClick={(event) => {
                      if (!interactive || readonly || node.type !== "leaf")
                        return;
                      event.stopPropagation();
                      onEdit?.(node.id, "value");
                    }}
                    x={node.type === "section" ? width - 8 : width / 2}
                    y={
                      node.type === "section"
                        ? DATA_TREEMAP_SECTION_HEADER / 2
                        : height / 2 + 20
                    }
                    textAnchor={node.type === "section" ? "end" : "middle"}
                    style={{ fill: input.appearance?.text }}
                  >
                    {valueFormatter(
                      node.type === "leaf" ? node.value : node.aggregate,
                    )}
                  </text>
                ) : null}
                {interactive && !readonly && validParentIds.length ? (
                  <title>{labels.move}</title>
                ) : null}
              </g>
            );
          })}
          {layout.flatMap((node) => {
            const input = inputById.get(node.id);
            if (!input) return [];
            const markers: ReactNode[] = [];
            if (input.commentCount) {
              const openComment = () => onOpenComment?.(node.id);
              markers.push(
                <g
                  aria-label={labels.comments(input.commentCount)}
                  className="myoxus-data-treemap-comment"
                  key={`${node.id}:comments`}
                  onClick={openComment}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    openComment();
                  }}
                  role="button"
                  tabIndex={interactive ? 0 : undefined}
                  transform={`translate(${Math.max(node.x0 + 10, node.x1 - 10)}, ${Math.max(node.y0 + 10, node.y1 - 10)})`}
                >
                  <circle r="8" />
                  <text textAnchor="middle" y="4">
                    {input.commentCount}
                  </text>
                </g>,
              );
            }
            if (input.className) {
              const openClass = () => onOpenClass?.(node.id);
              markers.push(
                <g
                  aria-label={`${labels.className}: ${input.className}`}
                  className="myoxus-data-treemap-class"
                  key={`${node.id}:class`}
                  onClick={openClass}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    openClass();
                  }}
                  role="button"
                  tabIndex={interactive ? 0 : undefined}
                  transform={`translate(${node.x0 + 10}, ${Math.max(node.y0 + 10, node.y1 - 10)})`}
                >
                  <rect
                    height="16"
                    rx="3"
                    width={Math.min(
                      88,
                      Math.max(28, input.className.length * 7 + 12),
                    )}
                    x="-2"
                    y="-12"
                  />
                  <text y="0">{textForWidth(input.className, 76)}</text>
                </g>,
              );
            }
            return markers;
          })}
          {diagramCommentCount ? (
            <g
              aria-label={labels.comments(diagramCommentCount)}
              className="myoxus-data-treemap-diagram-comment"
              onClick={onOpenDiagramComment}
              onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                onOpenDiagramComment?.();
              }}
              role="button"
              tabIndex={interactive ? 0 : undefined}
              transform={`translate(${Math.max(14, width - 18)}, 18)`}
            >
              <circle r="10" />
              <text textAnchor="middle" y="4">
                {diagramCommentCount}
              </text>
            </g>
          ) : null}
        </svg>
        {editor && editorAnchor ? (
          <div
            className="myoxus-data-treemap-editor"
            style={{
              ...(editorAnchor.x0 < width / 2
                ? { left: `${Math.max(0, (editorAnchor.x0 / width) * 100)}%` }
                : {
                    right: `${Math.max(0, ((width - editorAnchor.x1) / width) * 100)}%`,
                  }),
              ...(editorAnchor.y0 < height / 2
                ? { top: `${Math.max(0, (editorAnchor.y0 / height) * 100)}%` }
                : {
                    bottom: `${Math.max(0, ((height - editorAnchor.y1) / height) * 100)}%`,
                  }),
            }}
          >
            {editor}
          </div>
        ) : null}
      </div>
    </DataChartShell>
  );
}
