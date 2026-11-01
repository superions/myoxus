// SPDX-License-Identifier: AGPL-3.0-or-later

import type { KeyboardEvent, PointerEvent, ReactNode } from "react";
import { useEffect, useId, useMemo, useRef } from "react";

import {
  DataChartShell,
  localizedChartNumber,
  type DataChartValueFormatter,
} from "./chart-shell";
import { useResponsiveElementSize } from "../../responsive";
import {
  computeDataSankeyLayout,
  type DataSankeyLayoutLinkInput,
  type DataSankeyLayoutNodeInput,
} from "./sankey-layout";

export type DataSankeySelection = {
  readonly id: string;
  readonly kind: "comment" | "link" | "node";
} | null;

export type DataSankeyConnectionDraft = {
  readonly field?: "source" | "target";
  readonly linkId?: string;
  readonly sourceId: string;
  readonly targetId?: string;
  readonly validTargetIds: readonly string[];
};

export type DataSankeyChartProps = {
  readonly ariaDescription?: string;
  readonly ariaLabel: string;
  readonly connectionDraft?: DataSankeyConnectionDraft;
  readonly compact?: boolean;
  readonly emptyAction?: ReactNode;
  readonly emptyLabel: string;
  readonly focusRequestKey?: string | number;
  readonly geometry?: {
    readonly alignment: "center" | "justify" | "left" | "right";
    readonly height: number;
    readonly labelStyle: "legacy" | "outlined";
    readonly nodePadding: number;
    readonly nodeWidth: number;
    readonly showValues: boolean;
    readonly useMaxWidth: boolean;
    readonly width: number;
  };
  readonly interactive?: boolean;
  readonly labels: {
    readonly comments: (count: number) => string;
    readonly connectFromNode: string;
    readonly reconnectSource: string;
    readonly reconnectTarget: string;
  };
  readonly linkColor?: "gradient" | "source" | "target" | string;
  readonly linkComments?: readonly {
    readonly id: string;
    readonly linkId: string;
  }[];
  readonly links: readonly DataSankeyLayoutLinkInput[];
  readonly nodes: readonly (DataSankeyLayoutNodeInput & {
    readonly color?: string;
  })[];
  readonly onConnectStart?: (nodeId: string) => void;
  readonly onConnectionCancel?: () => void;
  readonly onConnectionCommit?: (nodeId: string) => void;
  readonly onEdit?: (selection: Exclude<DataSankeySelection, null>) => void;
  readonly onReconnectStart?: (
    linkId: string,
    field: "source" | "target",
  ) => void;
  readonly onOpenComment?: (commentId: string, linkId: string) => void;
  readonly onSelect?: (selection: Exclude<DataSankeySelection, null>) => void;
  readonly readonly?: boolean;
  readonly selected?: DataSankeySelection;
  readonly valueFormatter?: DataChartValueFormatter;
  readonly valuePrefix?: string;
  readonly valueSuffix?: string;
};

const DEFAULT_GEOMETRY = {
  alignment: "justify",
  height: 400,
  labelStyle: "legacy",
  nodePadding: 12,
  nodeWidth: 10,
  showValues: true,
  useMaxWidth: true,
  width: 600,
} as const;

function scrollConnectionViewport(
  svg: SVGSVGElement,
  clientX: number,
  clientY: number,
) {
  let viewport: HTMLElement | null = svg.parentElement;
  while (viewport) {
    const style = getComputedStyle(viewport);
    const scrollable = /(auto|scroll)/.test(
      `${style.overflow}${style.overflowX}${style.overflowY}`,
    );
    if (
      scrollable &&
      (viewport.scrollWidth > viewport.clientWidth ||
        viewport.scrollHeight > viewport.clientHeight)
    )
      break;
    viewport = viewport.parentElement;
  }
  if (!viewport) return;
  const bounds = viewport.getBoundingClientRect();
  const edge = 32;
  const step = 12;
  viewport.scrollBy({
    left:
      clientX < bounds.left + edge
        ? -step
        : clientX > bounds.right - edge
          ? step
          : 0,
    top:
      clientY < bounds.top + edge
        ? -step
        : clientY > bounds.bottom - edge
          ? step
          : 0,
  });
}

/** Accessible single-SVG Sankey renderer; product commands stay in the host. */
export function DataSankeyChart({
  ariaDescription,
  ariaLabel,
  connectionDraft,
  compact = false,
  emptyAction,
  emptyLabel,
  focusRequestKey,
  geometry = DEFAULT_GEOMETRY,
  interactive = true,
  labels,
  linkColor = "gradient",
  linkComments = [],
  links,
  nodes,
  onConnectStart,
  onConnectionCancel,
  onConnectionCommit,
  onEdit,
  onReconnectStart,
  onOpenComment,
  onSelect,
  readonly = false,
  selected = null,
  valueFormatter = localizedChartNumber,
  valuePrefix = "",
  valueSuffix = "",
}: DataSankeyChartProps) {
  const rootRef = useRef<HTMLElement | null>(null);
  const activePointer = useRef<
    { readonly id: number; readonly x: number; readonly y: number } | undefined
  >(undefined);
  const previewPath = useRef<SVGPathElement | null>(null);
  const { ref: surfaceRef, width: surfaceWidth } =
    useResponsiveElementSize<HTMLDivElement>();
  const gradientPrefix = useId().replaceAll(":", "");
  // Keep the SVG coordinate space at display scale on narrow owners. Scaling
  // a fixed 600px viewBox would also shrink labels and keyboard handles.
  const layoutWidth =
    surfaceWidth > 0
      ? Math.max(1, Math.min(geometry.width, Math.floor(surfaceWidth)))
      : geometry.width;
  const layout = useMemo(
    () =>
      computeDataSankeyLayout({
        alignment: geometry.alignment,
        height: geometry.height,
        links,
        nodePadding: geometry.nodePadding + (geometry.showValues ? 15 : 0),
        nodeWidth: geometry.nodeWidth,
        nodes,
        width: layoutWidth,
      }),
    [geometry, layoutWidth, links, nodes],
  );
  const selectedKey = selected ? `${selected.kind}:${selected.id}` : undefined;
  useEffect(() => {
    if (!selected) return;
    rootRef.current
      ?.querySelector<HTMLElement>(
        `[data-chart-${selected.kind}-id="${CSS.escape(selected.id)}"]`,
      )
      ?.focus();
  }, [focusRequestKey, selectedKey]);
  const ordered = [
    ...layout.nodes.map((node) => ({ id: node.id, kind: "node" as const })),
    ...layout.links.map((link) => ({ id: link.id, kind: "link" as const })),
    ...linkComments.map((comment) => ({
      id: comment.id,
      kind: "comment" as const,
    })),
  ];
  const keyboard = (
    event: KeyboardEvent<SVGGElement>,
    selection: Exclude<DataSankeySelection, null>,
  ) => {
    if (event.key === "Enter") {
      event.preventDefault();
      if (selection.kind === "comment") {
        const comment = linkComments.find(({ id }) => id === selection.id);
        if (comment) onOpenComment?.(comment.id, comment.linkId);
      } else onEdit?.(selection);
      return;
    }
    if (event.key === "Escape" && connectionDraft) {
      event.preventDefault();
      onConnectionCancel?.();
      return;
    }
    if (!event.key.startsWith("Arrow")) return;
    event.preventDefault();
    const index = ordered.findIndex(
      (item) => item.kind === selection.kind && item.id === selection.id,
    );
    const offset =
      event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1;
    const next = ordered[(index + offset + ordered.length) % ordered.length];
    if (next) onSelect?.(next);
  };
  const nodeById = new Map(layout.nodes.map((node) => [node.id, node]));
  const nodeColor = new Map(nodes.map((node) => [node.id, node.color]));
  const resolveLinkColor = (sourceId: string, targetId: string, id: string) => {
    if (linkColor === "gradient") return `url(#${gradientPrefix}-${id})`;
    if (linkColor === "source") return nodeColor.get(sourceId);
    if (linkColor === "target") return nodeColor.get(targetId);
    return linkColor;
  };
  const targetAt = (clientX: number, clientY: number) =>
    document
      .elementFromPoint(clientX, clientY)
      ?.closest<SVGGElement>("[data-chart-node-id]")?.dataset.chartNodeId;
  const startPointer = (
    event: PointerEvent<SVGCircleElement>,
    start: () => void,
  ) => {
    event.stopPropagation();
    start();
    activePointer.current = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
    };
    event.currentTarget.ownerSVGElement?.setPointerCapture(event.pointerId);
  };
  return (
    <DataChartShell
      ariaDescription={ariaDescription}
      ariaLabel={ariaLabel}
      empty={links.length === 0}
      emptyAction={emptyAction}
      emptyLabel={emptyLabel}
      rootRef={rootRef}
      selectedId={selected?.id}
      testId="data-sankey-chart"
    >
      <div
        ref={surfaceRef}
        className="myoxus-data-sankey-chart-surface"
        data-compact={compact || undefined}
      >
        <svg
          role="application"
          aria-label={ariaLabel}
          data-use-max-width={geometry.useMaxWidth || undefined}
          viewBox={`0 0 ${layoutWidth} ${geometry.height}`}
          preserveAspectRatio="xMidYMid meet"
          onPointerMove={(event) => {
            if (
              activePointer.current?.id !== event.pointerId ||
              !connectionDraft
            )
              return;
            scrollConnectionViewport(
              event.currentTarget,
              event.clientX,
              event.clientY,
            );
            const id = targetAt(event.clientX, event.clientY);
            if (id && connectionDraft.validTargetIds.includes(id)) {
              event.currentTarget.dataset.connectionTargetId = id;
              const source = nodeById.get(connectionDraft.sourceId);
              const target = nodeById.get(id);
              if (source && target && previewPath.current) {
                const x0 = source.x1;
                const y0 = (source.y0 + source.y1) / 2;
                const x1 = target.x0;
                const y1 = (target.y0 + target.y1) / 2;
                const midpoint = (x0 + x1) / 2;
                previewPath.current.setAttribute(
                  "d",
                  `M${x0},${y0}C${midpoint},${y0},${midpoint},${y1},${x1},${y1}`,
                );
              }
            } else {
              delete event.currentTarget.dataset.connectionTargetId;
              previewPath.current?.removeAttribute("d");
            }
          }}
          onPointerUp={(event) => {
            const pointer = activePointer.current;
            if (pointer?.id !== event.pointerId) return;
            const id = targetAt(event.clientX, event.clientY);
            activePointer.current = undefined;
            event.currentTarget.releasePointerCapture(event.pointerId);
            delete event.currentTarget.dataset.connectionTargetId;
            previewPath.current?.removeAttribute("d");
            if (id && connectionDraft?.validTargetIds.includes(id))
              onConnectionCommit?.(id);
            else if (
              Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) >
              4
            )
              onConnectionCancel?.();
          }}
          onPointerCancel={(event) => {
            if (activePointer.current?.id !== event.pointerId) return;
            activePointer.current = undefined;
            delete event.currentTarget.dataset.connectionTargetId;
            previewPath.current?.removeAttribute("d");
            onConnectionCancel?.();
          }}
        >
          <defs>
            {layout.links.map((link) => (
              <linearGradient
                key={link.id}
                id={`${gradientPrefix}-${link.id}`}
                gradientUnits="userSpaceOnUse"
                x1={nodeById.get(link.sourceId)?.x1}
                x2={nodeById.get(link.targetId)?.x0}
              >
                <stop
                  stopColor={
                    nodeColor.get(link.sourceId) ??
                    "var(--myoxus-accent-primary)"
                  }
                />
                <stop
                  offset="1"
                  stopColor={
                    nodeColor.get(link.targetId) ??
                    "var(--myoxus-sem-status-success)"
                  }
                />
              </linearGradient>
            ))}
          </defs>
          <g>
            {layout.links.map((link) => {
              const selection = { kind: "link" as const, id: link.id };
              return (
                <g
                  key={link.id}
                  data-chart-link-id={link.id}
                  data-selected={
                    (selected?.kind === "link" && selected.id === link.id) ||
                    undefined
                  }
                  tabIndex={interactive ? 0 : undefined}
                  role={interactive ? "button" : undefined}
                  aria-label={`${nodeById.get(link.sourceId)?.label} – ${nodeById.get(link.targetId)?.label}: ${valuePrefix}${valueFormatter(link.value)}${valueSuffix}`}
                  onClick={
                    interactive
                      ? (event) => {
                          event.currentTarget.focus();
                          onSelect?.(selection);
                        }
                      : undefined
                  }
                  onDoubleClick={
                    interactive ? () => onEdit?.(selection) : undefined
                  }
                  onKeyDown={
                    interactive
                      ? (event) => keyboard(event, selection)
                      : undefined
                  }
                >
                  <title>{`${nodeById.get(link.sourceId)?.label} – ${nodeById.get(link.targetId)?.label}: ${valuePrefix}${valueFormatter(link.value)}${valueSuffix}`}</title>
                  <path
                    d={link.path}
                    className="myoxus-data-sankey-link-hitarea"
                    strokeWidth={Math.max(link.width, 14)}
                  />
                  <path
                    d={link.path}
                    className="myoxus-data-sankey-link"
                    data-zero={link.value === 0 || undefined}
                    stroke={resolveLinkColor(
                      link.sourceId,
                      link.targetId,
                      link.id,
                    )}
                    strokeWidth={Math.max(link.width, 1)}
                  />
                  {!readonly &&
                  selected?.kind === "link" &&
                  selected.id === link.id ? (
                    <>
                      <circle
                        className="myoxus-data-sankey-handle"
                        cx={nodeById.get(link.sourceId)?.x1}
                        cy={link.y0}
                        r="7"
                        role="button"
                        aria-label={labels.reconnectSource}
                        tabIndex={0}
                        onPointerDown={(event) =>
                          startPointer(event, () =>
                            onReconnectStart?.(link.id, "source"),
                          )
                        }
                        onClick={(event) => {
                          event.stopPropagation();
                          onReconnectStart?.(link.id, "source");
                        }}
                      />
                      <circle
                        className="myoxus-data-sankey-handle"
                        cx={nodeById.get(link.targetId)?.x0}
                        cy={link.y1}
                        r="7"
                        role="button"
                        aria-label={labels.reconnectTarget}
                        tabIndex={0}
                        onPointerDown={(event) =>
                          startPointer(event, () =>
                            onReconnectStart?.(link.id, "target"),
                          )
                        }
                        onClick={(event) => {
                          event.stopPropagation();
                          onReconnectStart?.(link.id, "target");
                        }}
                      />
                    </>
                  ) : null}
                </g>
              );
            })}
          </g>
          {connectionDraft ? (
            <path
              ref={previewPath}
              className="myoxus-data-sankey-connection-preview"
            />
          ) : null}
          <g>
            {layout.links.flatMap((link) => {
              const comments = linkComments.filter(
                ({ linkId }) => linkId === link.id,
              );
              const source = nodeById.get(link.sourceId);
              const target = nodeById.get(link.targetId);
              if (!comments.length || !source || !target) return [];
              return comments.map((comment, index) => {
                const selection = {
                  kind: "comment" as const,
                  id: comment.id,
                };
                return (
                  <g
                    key={comment.id}
                    className="myoxus-data-sankey-comment-marker"
                    data-chart-comment-id={comment.id}
                    data-selected={
                      (selected?.kind === "comment" &&
                        selected.id === comment.id) ||
                      undefined
                    }
                    role="button"
                    tabIndex={interactive ? 0 : undefined}
                    aria-label={labels.comments(1)}
                    transform={`translate(${(source.x1 + target.x0) / 2} ${(link.y0 + link.y1) / 2 + index * 20})`}
                    onClick={
                      interactive
                        ? (event) => {
                            event.stopPropagation();
                            event.currentTarget.focus();
                            onSelect?.(selection);
                          }
                        : undefined
                    }
                    onDoubleClick={
                      interactive
                        ? () => onOpenComment?.(comment.id, comment.linkId)
                        : undefined
                    }
                    onKeyDown={
                      interactive
                        ? (event) => keyboard(event, selection)
                        : undefined
                    }
                  >
                    <circle r="9" />
                    <text textAnchor="middle" dominantBaseline="central">
                      {index + 1}
                    </text>
                  </g>
                );
              });
            })}
          </g>
          <g>
            {layout.nodes.map((node) => {
              const selection = { kind: "node" as const, id: node.id };
              const labelOnLeft = node.x0 >= layoutWidth / 2;
              const labelX = labelOnLeft ? node.x0 - 8 : node.x1 + 8;
              return (
                <g
                  key={node.id}
                  data-chart-node-id={node.id}
                  data-selected={
                    (selected?.kind === "node" && selected.id === node.id) ||
                    undefined
                  }
                  data-connect-target={
                    connectionDraft?.validTargetIds.includes(node.id) ||
                    undefined
                  }
                  tabIndex={interactive ? 0 : undefined}
                  role={interactive ? "button" : undefined}
                  aria-label={`${node.label}${geometry.showValues ? `: ${valuePrefix}${valueFormatter(node.value)}${valueSuffix}` : ""}`}
                  onClick={
                    interactive
                      ? (event) => {
                          if (
                            connectionDraft?.validTargetIds.includes(node.id)
                          ) {
                            event.stopPropagation();
                            onConnectionCommit?.(node.id);
                          } else if (!connectionDraft) {
                            event.currentTarget.focus();
                            onSelect?.(selection);
                          }
                        }
                      : undefined
                  }
                  onDoubleClick={
                    interactive ? () => onEdit?.(selection) : undefined
                  }
                  onKeyDown={
                    interactive
                      ? (event) => keyboard(event, selection)
                      : undefined
                  }
                >
                  <title>
                    {node.label}
                    {geometry.showValues
                      ? `: ${valuePrefix}${valueFormatter(node.value)}${valueSuffix}`
                      : ""}
                  </title>
                  <rect
                    className="myoxus-data-sankey-node"
                    data-zero={node.value === 0 || undefined}
                    x={node.x0}
                    y={node.y0}
                    width={Math.max(1, node.x1 - node.x0)}
                    height={Math.max(2, node.y1 - node.y0)}
                    fill={nodeColor.get(node.id)}
                  />
                  <text
                    className="myoxus-data-sankey-label"
                    data-outlined={
                      geometry.labelStyle === "outlined" || undefined
                    }
                    x={labelX}
                    y={(node.y0 + node.y1) / 2}
                    textAnchor={labelOnLeft ? "end" : "start"}
                    dominantBaseline="middle"
                  >
                    <tspan>{node.label}</tspan>
                    {geometry.showValues ? (
                      <tspan x={labelX} dy="1.2em">
                        {valuePrefix}
                        {valueFormatter(node.value)}
                        {valueSuffix}
                      </tspan>
                    ) : null}
                  </text>
                  {!readonly &&
                  selected?.kind === "node" &&
                  selected.id === node.id ? (
                    <circle
                      className="myoxus-data-sankey-handle"
                      cx={node.x1}
                      cy={(node.y0 + node.y1) / 2}
                      r="7"
                      role="button"
                      aria-label={labels.connectFromNode}
                      tabIndex={0}
                      onPointerDown={(event) =>
                        startPointer(event, () => onConnectStart?.(node.id))
                      }
                      onClick={(event) => {
                        event.stopPropagation();
                        onConnectStart?.(node.id);
                      }}
                    />
                  ) : null}
                </g>
              );
            })}
          </g>
        </svg>
      </div>
    </DataChartShell>
  );
}
