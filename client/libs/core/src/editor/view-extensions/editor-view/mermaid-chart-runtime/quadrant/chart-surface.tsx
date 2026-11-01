// SPDX-License-Identifier: AGPL-3.0-or-later

import { Button, DataScatterChart } from "@myoxus/ui-facade";
import { PlusIcon } from "@myoxus/icons";
import type {
  MermaidQuadrantConfig,
  MermaidQuadrantReactHostProps,
  MermaidQuadrantPoint,
} from "@virgultum/block-mermaid";
import { DEFAULT_MERMAID_QUADRANT_CONFIG } from "@virgultum/block-mermaid";
import { renderSafeMarkdownLabel } from "../../mermaid-markdown-label";

import { MermaidQuadrantPointPopover } from "./point-popover";
import { MermaidQuadrantComments } from "./comments";

const QUADRANT_AREA_FILLS = [
  "color-mix(in srgb, var(--myoxus-accent-primary) 14%, transparent)",
  "color-mix(in srgb, var(--myoxus-sem-status-success) 14%, transparent)",
  "color-mix(in srgb, var(--myoxus-sem-status-warning) 14%, transparent)",
  "color-mix(in srgb, var(--myoxus-sem-status-info) 14%, transparent)",
] as const;

// Canvas text has no native ellipsis. This measured average-em estimate keeps
// labels responsive to the configured chart width and font size without a
// route-specific pixel cap; the full source text remains in the SVG tooltip.
const AVERAGE_GLYPH_EM = 0.58;

function labelCharacterCapacity(width: number, fontSize: number) {
  return Math.max(1, Math.floor(width / (fontSize * AVERAGE_GLYPH_EM)));
}

function truncateLabel(label: string, capacity: number) {
  return label.length <= capacity
    ? label
    : `${label.slice(0, Math.max(1, capacity - 1))}…`;
}

function visibleMarkdownText(source: string) {
  return source.replace(/`|\*\*?|__/g, "");
}

type PointLabelBox = {
  bottom: number;
  left: number;
  right: number;
  top: number;
};

function boxesOverlap(left: PointLabelBox, right: PointLabelBox) {
  return !(
    left.right <= right.left ||
    left.left >= right.right ||
    left.bottom <= right.top ||
    left.top >= right.bottom
  );
}

// SVG text has no native collision layout. Use the configured renderer
// geometry and the same average-em estimate as truncation to stagger only
// labels whose projected boxes would overlap; source coordinates stay intact.
function pointLabelOffsets(
  points: ReadonlyArray<MermaidQuadrantPoint>,
  config: Required<MermaidQuadrantConfig>,
  labelCapacity: number,
  visibleLabels: ReadonlyMap<string, string>,
) {
  const occupied: PointLabelBox[] = [];
  const offsets = new Map<string, number>();
  const lineHeight = config.pointLabelFontSize * 1.4;
  const topClearance =
    config.quadrantTextTopPadding +
    config.quadrantLabelFontSize +
    config.pointTextPadding +
    config.pointLabelFontSize;
  const bottomClearance =
    config.xAxisLabelPadding +
    config.xAxisLabelFontSize +
    config.pointTextPadding +
    config.pointLabelFontSize;
  const chartHeight = Math.max(config.chartHeight, 1);
  const chartWidth = Math.max(config.chartWidth, 1);
  for (const point of [...points].sort(
    (left, right) => right.y - left.y || left.x - right.x,
  )) {
    const x = point.x * chartWidth;
    const y = (1 - point.y) * chartHeight;
    const label =
      visibleLabels.get(point.id) ?? visibleMarkdownText(point.label);
    const textWidth =
      Math.min(label.length, labelCapacity) *
      config.pointLabelFontSize *
      AVERAGE_GLYPH_EM;
    const left =
      point.x > 0.75
        ? x - config.pointTextPadding - textWidth
        : x + config.pointTextPadding;
    const baseOffset =
      point.y >= 1 - topClearance / chartHeight
        ? topClearance
        : point.y <= bottomClearance / chartHeight
          ? -bottomClearance
          : -config.pointTextPadding;
    const direction = baseOffset > 0 ? 1 : -1;
    let offset = baseOffset;
    for (let tier = 0; tier <= points.length * 2; tier += 1) {
      const distance = Math.ceil(tier / 2) * lineHeight;
      const candidateOffset =
        baseOffset +
        (tier === 0
          ? 0
          : tier % 2
            ? direction * distance
            : -direction * distance);
      const candidate = {
        bottom: y + candidateOffset + config.pointLabelFontSize * 0.25,
        left,
        right: left + textWidth,
        top: y + candidateOffset - config.pointLabelFontSize,
      };
      if (
        candidate.top >= 0 &&
        candidate.bottom <= chartHeight &&
        !occupied.some((box) => boxesOverlap(box, candidate))
      ) {
        offset = candidateOffset;
        occupied.push(candidate);
        break;
      }
    }
    offsets.set(point.id, offset);
  }
  return offsets;
}

function pointStyle(
  props: MermaidQuadrantReactHostProps,
  point: MermaidQuadrantPoint,
  preview?: {
    readonly className?: string;
    readonly inlineStyle: MermaidQuadrantPoint["inlineStyle"];
    readonly reorderDirection?: -1 | 1;
  },
) {
  const className = preview?.className ?? point.className;
  const classStyle = props.model.classes.find(
    (classDef) => classDef.name === className,
  )?.style;
  return { ...classStyle, ...(preview?.inlineStyle ?? point.inlineStyle) };
}

export function MermaidQuadrantChartSurface({
  appearancePreview,
  commentsVisible,
  draft,
  editor,
  onEditorClose,
  onEditorOpen,
  onAdd,
  onDraftMove,
  onDraftInvalidated,
  onCommentCommand,
  onPointApply,
  onPointAppearancePreview,
  onPointDelete,
  onPointReorder,
  onMove,
  onMovePreview,
  onSelect,
  onTextApply,
  props,
  pointAppearancePreview,
  selectedId,
}: {
  readonly appearancePreview: MermaidQuadrantConfig | null;
  readonly commentsVisible: boolean;
  readonly draft: MermaidQuadrantPoint | null;
  readonly editor: "coordinates" | "label" | null;
  readonly onEditorClose: () => void;
  readonly onEditorOpen: (mode: "coordinates" | "label", id: string) => void;
  readonly onAdd: () => void;
  readonly onDraftMove: (x: number, y: number) => void;
  readonly onDraftInvalidated: () => void;
  readonly onCommentCommand: (
    command: import("@virgultum/block-mermaid").MermaidQuadrantCommand,
  ) => boolean;
  readonly onPointApply: (
    point: MermaidQuadrantPoint,
    draft: {
      className?: string;
      inlineStyle: MermaidQuadrantPoint["inlineStyle"];
      label: string;
      labelForm: MermaidQuadrantPoint["labelForm"];
      reorderDirection?: -1 | 1;
      x: number;
      y: number;
    },
  ) => boolean;
  readonly onPointAppearancePreview: (
    preview: {
      readonly className?: string;
      readonly inlineStyle: MermaidQuadrantPoint["inlineStyle"];
      readonly reorderDirection?: -1 | 1;
    } | null,
  ) => void;
  readonly onPointDelete: (id: string) => void;
  readonly onPointReorder: (id: string, direction: -1 | 1) => void;
  readonly onMove: (id: string, x: number, y: number) => boolean;
  readonly onMovePreview: (id?: string, x?: number, y?: number) => void;
  readonly onSelect: (id: string) => void;
  readonly onTextApply: (id: string, value: string) => boolean;
  readonly props: MermaidQuadrantReactHostProps;
  readonly pointAppearancePreview: {
    readonly className?: string;
    readonly inlineStyle: MermaidQuadrantPoint["inlineStyle"];
    readonly reorderDirection?: -1 | 1;
  } | null;
  readonly selectedId?: string;
}) {
  const config = {
    ...DEFAULT_MERMAID_QUADRANT_CONFIG,
    ...props.model.config,
    ...appearancePreview,
  };
  const pointLabelCapacity = labelCharacterCapacity(
    config.chartWidth / 4 - config.pointTextPadding,
    config.pointLabelFontSize,
  );
  const referenceLabelCapacity = labelCharacterCapacity(
    config.chartWidth / 2 - config.quadrantPadding,
    Math.max(config.quadrantLabelFontSize, config.xAxisLabelFontSize),
  );
  const sourceOrderedPoints = [
    ...props.model.points,
    ...(draft ? [draft] : []),
  ].sort((left, right) => left.order - right.order);
  if (selectedId && pointAppearancePreview?.reorderDirection) {
    const current = sourceOrderedPoints.findIndex(
      (point) => point.id === selectedId,
    );
    const target = Math.max(
      0,
      Math.min(
        sourceOrderedPoints.length - 1,
        current + pointAppearancePreview.reorderDirection,
      ),
    );
    if (current >= 0 && target !== current) {
      const [point] = sourceOrderedPoints.splice(current, 1);
      if (point) sourceOrderedPoints.splice(target, 0, point);
    }
  }
  const projectedPoints = sourceOrderedPoints.reverse();
  const visiblePointLabels = new Map(
    projectedPoints.map((point) => {
      const comments = props.comments.filter(
        (comment) =>
          comment.anchor.kind === "point" && comment.anchor.id === point.id,
      ).length;
      const hasInlineStyle = Object.values(point.inlineStyle).some(
        (value) => value !== undefined,
      );
      return [
        point.id,
        [
          visibleMarkdownText(point.label),
          point.className,
          hasInlineStyle ? props.labels.style : undefined,
          comments ? `${props.labels.comments} ${comments}` : undefined,
        ]
          .filter(Boolean)
          .join(" "),
      ];
    }),
  );
  const labelOffsets = pointLabelOffsets(
    projectedPoints,
    config,
    pointLabelCapacity,
    visiblePointLabels,
  );
  return (
    <DataScatterChart
      ariaLabel={props.labels.chart}
      externalBorderWidth={config.quadrantExternalBorderStrokeWidth}
      emptyAction={
        props.readonly ? undefined : (
          <Button prefix={<PlusIcon />} onClick={onAdd}>
            {props.labels.add}
          </Button>
        )
      }
      emptyLabel={props.labels.empty}
      height={config.chartHeight}
      onCoordinateEditor={
        props.readonly ? undefined : (id) => onEditorOpen("coordinates", id)
      }
      onLabelEditor={
        props.readonly ? undefined : (id) => onEditorOpen("label", id)
      }
      onMoveCancel={(id) => onMovePreview(id)}
      onMoveCommit={({ id, x, y }) =>
        draft?.id === id ? onDraftMove(x, y) : onMove(id, x, y)
      }
      onMovePreview={(move) => onMovePreview(move?.id, move?.x, move?.y)}
      onSelect={props.readonly ? undefined : onSelect}
      onReferenceLabelApply={props.readonly ? undefined : onTextApply}
      onReorderPoint={props.readonly ? undefined : onPointReorder}
      onReorderPreview={
        props.readonly
          ? undefined
          : (id, direction) => {
              const point = props.model.points.find(
                (candidate) => candidate.id === id,
              );
              onPointAppearancePreview(
                direction && point
                  ? {
                      className: point.className,
                      inlineStyle: point.inlineStyle,
                      reorderDirection: direction,
                    }
                  : null,
              );
            }
      }
      points={projectedPoints.map((point) => {
        const sourceIndex = props.model.points.findIndex(
          (candidate) => candidate.id === point.id,
        );
        const style = pointStyle(
          props,
          point,
          point.id === selectedId
            ? (pointAppearancePreview ?? undefined)
            : undefined,
        );
        const comments = props.comments.filter(
          (comment) =>
            comment.anchor.kind === "point" && comment.anchor.id === point.id,
        ).length;
        const diagnostics = props.model.diagnostics.filter(
          (diagnostic) => diagnostic.recordId === point.sourceRecordId,
        );
        const hasInlineStyle = Object.values(point.inlineStyle).some(
          (value) => value !== undefined,
        );
        const badges = [
          point.className,
          hasInlineStyle ? props.labels.style : undefined,
          comments ? `${props.labels.comments} ${comments}` : undefined,
          diagnostics.length ? props.labels.invalid : undefined,
        ].filter(Boolean);
        return {
          accessibleLabel: [
            `${point.label}, ${props.labels.x} ${point.x}, ${props.labels.y} ${point.y}, ${sourceIndex + 1}`,
            ...diagnostics.map((diagnostic) => diagnostic.message),
          ].join(". "),
          badge: badges.length ? badges.join(" · ") : undefined,
          color: style.color,
          decoration:
            point.id === selectedId && editor ? (
              <MermaidQuadrantPointPopover
                mode={editor}
                layerActions={point.id !== draft?.id}
                onApply={(value) => onPointApply(point, value)}
                onClose={onEditorClose}
                onDelete={() => onPointDelete(point.id)}
                onPreview={onPointAppearancePreview}
                point={point}
                preview={pointAppearancePreview ?? undefined}
                props={props}
              />
            ) : commentsVisible && point.id !== draft?.id ? (
              <MermaidQuadrantComments
                anchor={{ id: point.id, kind: "point" }}
                onCommand={onCommentCommand}
                onDraftInvalidated={onDraftInvalidated}
                props={props}
              />
            ) : undefined,
          id: point.id,
          label: point.label,
          displayLabel:
            point.labelForm === "markdown"
              ? undefined
              : truncateLabel(point.label, pointLabelCapacity),
          labelStyle: {
            color: style.color,
            fontSize: config.pointLabelFontSize,
          },
          labelPadding: config.pointTextPadding,
          labelOffsetY: labelOffsets.get(point.id),
          radius: style.radius ?? config.pointRadius,
          renderedLabel:
            point.labelForm === "markdown"
              ? renderSafeMarkdownLabel(point.label, pointLabelCapacity)
              : undefined,
          strokeColor: style.strokeColor,
          strokeWidth: style.strokeWidth
            ? Number.parseFloat(style.strokeWidth)
            : undefined,
          x: point.x,
          y: point.y,
        };
      })}
      referenceAreas={[
        {
          fill: QUADRANT_AREA_FILLS[0],
          id: "q1",
          label: props.model.quadrantLabels[0],
          x1: 0.5,
          x2: 1,
          y1: 0.5,
          y2: 1,
        },
        {
          fill: QUADRANT_AREA_FILLS[1],
          id: "q2",
          label: props.model.quadrantLabels[1],
          x1: 0,
          x2: 0.5,
          y1: 0.5,
          y2: 1,
        },
        {
          fill: QUADRANT_AREA_FILLS[2],
          id: "q3",
          label: props.model.quadrantLabels[2],
          x1: 0,
          x2: 0.5,
          y1: 0,
          y2: 0.5,
        },
        {
          fill: QUADRANT_AREA_FILLS[3],
          id: "q4",
          label: props.model.quadrantLabels[3],
          x1: 0.5,
          x2: 1,
          y1: 0,
          y2: 0.5,
        },
      ]}
      plotPadding={Math.max(
        config.quadrantPadding,
        config.pointRadius + config.pointTextPadding,
      )}
      referenceLines={[
        {
          id: "x-center",
          strokeWidth: config.quadrantInternalBorderStrokeWidth,
          x: 0.5,
        },
        {
          id: "y-center",
          strokeWidth: config.quadrantInternalBorderStrokeWidth,
          y: 0.5,
        },
      ]}
      referenceLabels={[
        ...props.model.quadrantTexts.map((text, index) => ({
          anchor: "middle" as const,
          decoration: commentsVisible ? (
            <MermaidQuadrantComments
              anchor={{ id: text.id, kind: "quadrantText" }}
              onCommand={onCommentCommand}
              onDraftInvalidated={onDraftInvalidated}
              props={props}
            />
          ) : undefined,
          id: `quadrant-${index + 1}`,
          label: text.text,
          displayLabel:
            text.form === "markdown"
              ? undefined
              : truncateLabel(text.text, referenceLabelCapacity),
          labelStyle: { fontSize: config.quadrantLabelFontSize },
          offsetY: config.quadrantTextTopPadding + config.quadrantLabelFontSize,
          renderedLabel:
            text.form === "markdown"
              ? renderSafeMarkdownLabel(text.text, referenceLabelCapacity)
              : undefined,
          x: index === 0 || index === 3 ? 0.75 : 0.25,
          y: index < 2 ? 1 : 0.5,
        })),
        {
          anchor: "start",
          decoration: commentsVisible ? (
            <MermaidQuadrantComments
              anchor={{ id: props.model.axes.x.id, kind: "axis" }}
              onCommand={onCommentCommand}
              onDraftInvalidated={onDraftInvalidated}
              props={props}
            />
          ) : undefined,
          id: "x-start",
          label: props.model.xAxisStart,
          displayLabel:
            props.model.axes.x.startForm === "markdown"
              ? undefined
              : truncateLabel(props.model.xAxisStart, referenceLabelCapacity),
          labelStyle: { fontSize: config.xAxisLabelFontSize },
          offsetX: config.xAxisLabelPadding,
          offsetY:
            config.xAxisPosition === "bottom"
              ? -config.xAxisLabelPadding
              : config.xAxisLabelFontSize + config.xAxisLabelPadding,
          renderedLabel:
            props.model.axes.x.startForm === "markdown"
              ? renderSafeMarkdownLabel(
                  props.model.xAxisStart,
                  referenceLabelCapacity,
                )
              : undefined,
          x: 0,
          y: config.xAxisPosition === "bottom" ? 0 : 1,
        },
        {
          anchor: "end",
          id: "x-end",
          label: props.model.xAxisEnd,
          displayLabel:
            props.model.axes.x.endForm === "markdown"
              ? undefined
              : truncateLabel(props.model.xAxisEnd, referenceLabelCapacity),
          labelStyle: { fontSize: config.xAxisLabelFontSize },
          offsetX: -config.xAxisLabelPadding,
          offsetY:
            config.xAxisPosition === "bottom"
              ? -config.xAxisLabelPadding
              : config.xAxisLabelFontSize + config.xAxisLabelPadding,
          renderedLabel:
            props.model.axes.x.endForm === "markdown"
              ? renderSafeMarkdownLabel(
                  props.model.xAxisEnd,
                  referenceLabelCapacity,
                )
              : undefined,
          x: 1,
          y: config.xAxisPosition === "bottom" ? 0 : 1,
        },
        {
          anchor: config.yAxisPosition === "left" ? "start" : "end",
          decoration: commentsVisible ? (
            <MermaidQuadrantComments
              anchor={{ id: props.model.axes.y.id, kind: "axis" }}
              onCommand={onCommentCommand}
              onDraftInvalidated={onDraftInvalidated}
              props={props}
            />
          ) : undefined,
          id: "y-start",
          label: props.model.yAxisStart,
          displayLabel:
            props.model.axes.y.startForm === "markdown"
              ? undefined
              : truncateLabel(props.model.yAxisStart, referenceLabelCapacity),
          labelStyle: { fontSize: config.yAxisLabelFontSize },
          offsetX:
            config.yAxisPosition === "left"
              ? config.yAxisLabelPadding
              : -config.yAxisLabelPadding,
          offsetY: -config.yAxisLabelPadding,
          renderedLabel:
            props.model.axes.y.startForm === "markdown"
              ? renderSafeMarkdownLabel(
                  props.model.yAxisStart,
                  referenceLabelCapacity,
                )
              : undefined,
          x: config.yAxisPosition === "left" ? 0 : 1,
          y: 0,
        },
        {
          anchor: config.yAxisPosition === "left" ? "start" : "end",
          id: "y-end",
          label: props.model.yAxisEnd,
          displayLabel:
            props.model.axes.y.endForm === "markdown"
              ? undefined
              : truncateLabel(props.model.yAxisEnd, referenceLabelCapacity),
          labelStyle: { fontSize: config.yAxisLabelFontSize },
          offsetX:
            config.yAxisPosition === "left"
              ? config.yAxisLabelPadding
              : -config.yAxisLabelPadding,
          offsetY: config.yAxisLabelFontSize + config.yAxisLabelPadding,
          renderedLabel:
            props.model.axes.y.endForm === "markdown"
              ? renderSafeMarkdownLabel(
                  props.model.yAxisEnd,
                  referenceLabelCapacity,
                )
              : undefined,
          x: config.yAxisPosition === "left" ? 0 : 1,
          y: 1,
        },
      ]}
      selectedId={selectedId}
      xAxisEndLabel={props.model.xAxisEnd}
      xAxisStartLabel={props.model.xAxisStart}
      yAxisEndLabel={props.model.yAxisEnd}
      yAxisStartLabel={props.model.yAxisStart}
      width={config.useMaxWidth ? "100%" : config.chartWidth}
    />
  );
}
