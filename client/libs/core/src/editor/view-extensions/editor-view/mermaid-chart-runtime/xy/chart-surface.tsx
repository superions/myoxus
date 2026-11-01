// SPDX-License-Identifier: AGPL-3.0-or-later

import { AlertTriangleIcon } from "@myoxus/icons";
import {
  DataCompositeChart,
  Group,
  MyoxusText,
  Stack,
  ThemeIcon,
  Tooltip,
} from "@myoxus/ui-facade";
import {
  DEFAULT_MERMAID_XY_CONFIG,
  type MermaidXyConfig,
  type MermaidXyCommentCommand,
  type MermaidXyPlot,
  type MermaidXyPoint,
  type MermaidXyReactHostProps,
  type MermaidXyTextForm,
} from "@virgultum/block-mermaid";
import type { ReactNode } from "react";

import { CHART_COLORS } from "../common";
import {
  MermaidXyAxisTitlePopover,
  MermaidXyCategoryPopover,
  type MermaidXyEditorDraft,
  MermaidXyPlotPopover,
  MermaidXyValuePopover,
} from "./value-popover";
import { MermaidXyCommentMarker } from "./comments";

function XyDiagnosticMarker({
  diagnostics,
}: {
  readonly diagnostics: MermaidXyReactHostProps["model"]["diagnostics"];
}) {
  if (!diagnostics.length) return null;
  const label = diagnostics.map((diagnostic) => diagnostic.message).join(" ");
  return (
    <Tooltip
      content={
        <Stack gap="xs">
          {diagnostics.map((diagnostic) => (
            <MyoxusText key={diagnostic.id}>{diagnostic.message}</MyoxusText>
          ))}
        </Stack>
      }
    >
      <ThemeIcon
        aria-label={label}
        color={
          diagnostics.some((diagnostic) => diagnostic.severity === "error")
            ? "myoxusError"
            : "myoxusWarning"
        }
        role="img"
        variant="light"
      >
        <AlertTriangleIcon />
      </ThemeIcon>
    </Tooltip>
  );
}

function pointX(
  props: MermaidXyReactHostProps,
  plot: MermaidXyPlot,
  point: MermaidXyPoint,
) {
  if (props.model.xAxis.effectiveKind === "band") {
    return (
      props.model.xAxis.categories[point.order]?.id ??
      `xy-overflow-${plot.id}-${point.id}`
    );
  }
  const count = plot.points.length;
  if (count <= 1) return props.model.xAxis.effectiveMinimum;
  return (
    props.model.xAxis.effectiveMinimum +
    (point.order / (count - 1)) *
      (props.model.xAxis.effectiveMaximum - props.model.xAxis.effectiveMinimum)
  );
}

export function MermaidXyChartSurface({
  editingId,
  editorDraft,
  appearancePreview,
  onCancelPreview,
  onAxisTitleApply,
  onCategoryApply,
  onCommitPreview,
  onEdit,
  onEditClose,
  onEditorDraftChange,
  onDelete,
  onPointApply,
  onPlotApply,
  onPreviewReorder,
  onPreview,
  onSelect,
  emptyAction,
  focusRequestKey,
  onCommentCommand,
  onCommitReorder,
  preview,
  props,
  selectedId,
  showComments,
}: {
  readonly editingId?: string;
  readonly editorDraft?: MermaidXyEditorDraft;
  readonly emptyAction?: ReactNode;
  readonly focusRequestKey?: number;
  readonly appearancePreview?: MermaidXyConfig;
  readonly onCancelPreview: (pointId: string) => void;
  readonly onAxisTitleApply: (
    axis: "x" | "y",
    title: string,
    form: MermaidXyTextForm,
  ) => boolean;
  readonly onCategoryApply: (
    categoryId: string,
    label: string,
    reorderDirection: -1 | 0 | 1,
  ) => boolean;
  readonly onCommitPreview: (pointId: string, value: number) => void;
  readonly onEdit: (id: string) => void;
  readonly onEditClose: () => void;
  readonly onEditorDraftChange: (draft: MermaidXyEditorDraft) => void;
  readonly onDelete: (id: string) => void;
  readonly onPointApply: (
    point: MermaidXyPoint,
    value: number,
    label: string,
    labelForm: MermaidXyTextForm,
    reorderDirection: -1 | 0 | 1,
  ) => boolean;
  readonly onPlotApply: (
    plot: MermaidXyPlot,
    title: string,
    titleForm: MermaidXyTextForm,
    kind: "bar" | "line",
    reorderDirection: -1 | 0 | 1,
  ) => boolean;
  readonly onPreviewReorder: (
    kind: "category" | "plot" | "point",
    id: string,
    direction: -1 | 1 | null,
  ) => void;
  readonly onPreview: (pointId: string, value: number) => void;
  readonly onSelect: (id: string) => void;
  readonly onCommentCommand: (command: MermaidXyCommentCommand) => boolean;
  readonly onCommitReorder: (
    kind: "category" | "plot" | "point",
    id: string,
    direction: -1 | 1,
  ) => void;
  readonly preview?: { readonly id: string; readonly y: number };
  readonly props: MermaidXyReactHostProps;
  readonly selectedId?: string;
  readonly showComments: boolean;
}) {
  const plots = props.model.plots.map((plot, index) => {
    const diagnostics = props.model.diagnostics.filter(
      (diagnostic) => diagnostic.recordId === plot.sourceRecordId,
    );
    return {
      accessibleLabel: `${plot.titleExplicit ? plot.title : plot.kind === "bar" ? props.labels.bar : props.labels.line} · ${plot.kind === "bar" ? props.labels.bar : props.labels.line} ${plot.order + 1}`,
      color: CHART_COLORS[index % CHART_COLORS.length],
      id: plot.id,
      label: plot.titleExplicit
        ? plot.title
        : `${plot.kind === "bar" ? props.labels.bar : props.labels.line} ${index + 1}`,
      action:
        diagnostics.length > 0 || showComments ? (
          <Group gap="xs" wrap="nowrap">
            <XyDiagnosticMarker diagnostics={diagnostics} />
            {showComments ? (
              <MermaidXyCommentMarker
                anchor={{ id: plot.id, kind: "plot" }}
                onCommand={onCommentCommand}
                props={props}
              />
            ) : null}
          </Group>
        ) : undefined,
      points: plot.points.map((point) => ({
        id: point.id,
        displayY: Math.min(
          props.model.yAxis.maximum,
          Math.max(props.model.yAxis.minimum, point.value),
        ),
        label: point.label,
        missing:
          props.model.xAxis.effectiveKind === "band" &&
          point.order >= props.model.xAxis.categories.length,
        outOfRange:
          point.value > props.model.yAxis.maximum
            ? ("above" as const)
            : point.value < props.model.yAxis.minimum
              ? ("below" as const)
              : undefined,
        x: pointX(props, plot, point),
        xLabel:
          props.model.xAxis.effectiveKind === "band"
            ? (props.model.xAxis.categories[point.order]?.label ??
              props.labels.unmatchedPoint(point.order + 1))
            : undefined,
        y: point.value,
      })),
      type: plot.kind,
    };
  });
  const xAxisDiagnostics = props.model.diagnostics.filter(
    (diagnostic) => diagnostic.role === "x-axis",
  );
  const yAxisDiagnostics = props.model.diagnostics.filter(
    (diagnostic) => diagnostic.role === "y-axis",
  );
  const appearance = {
    ...DEFAULT_MERMAID_XY_CONFIG,
    ...props.model.config,
    ...appearancePreview,
    xAxis: {
      ...DEFAULT_MERMAID_XY_CONFIG.xAxis,
      ...props.model.config.xAxis,
      ...appearancePreview?.xAxis,
    },
    yAxis: {
      ...DEFAULT_MERMAID_XY_CONFIG.yAxis,
      ...props.model.config.yAxis,
      ...appearancePreview?.yAxis,
    },
  };
  return (
    <DataCompositeChart
      appearance={appearance}
      ariaDescription={props.model.accessibilityDescription || undefined}
      ariaLabel={props.model.accessibilityTitle || props.labels.chart}
      axisEditor={
        props.readonly
          ? undefined
          : (axis, controls) => (
              <MermaidXyAxisTitlePopover
                axis={axis.id === "xy-axis-x" ? "x" : "y"}
                onApply={(title, form) =>
                  onAxisTitleApply(
                    axis.id === "xy-axis-x" ? "x" : "y",
                    title,
                    form,
                  )
                }
                onCancel={controls.close}
                props={props}
              />
            )
      }
      axisEditorId={
        editingId === "xy-axis-x" || editingId === "xy-axis-y"
          ? editingId
          : undefined
      }
      categories={props.model.xAxis.categories.map((category) => ({
        accessibleLabel: `${category.label} · ${props.labels.category} ${category.order + 1}`,
        id: category.id,
        label: category.label,
      }))}
      categoryEditor={
        props.readonly
          ? undefined
          : (facadeCategory, controls) => {
              const category = props.model.xAxis.categories.find(
                (candidate) => candidate.id === facadeCategory.id,
              )!;
              return (
                <MermaidXyCategoryPopover
                  category={category}
                  draft={
                    editorDraft?.kind === "category" &&
                    editorDraft.id === category.id
                      ? editorDraft
                      : {
                          id: category.id,
                          kind: "category",
                          label: category.label,
                          reorderDirection: 0,
                        }
                  }
                  onApply={(label, direction) =>
                    onCategoryApply(category.id, label, direction)
                  }
                  onCancel={controls.close}
                  onDelete={() => onDelete(category.id)}
                  onDraftChange={onEditorDraftChange}
                  onPreviewReorder={(direction) =>
                    onPreviewReorder("category", category.id, direction)
                  }
                  props={props}
                />
              );
            }
      }
      categoryEditorId={
        props.model.xAxis.categories.some(
          (category) => category.id === editingId,
        )
          ? editingId
          : undefined
      }
      emptyLabel={props.labels.empty}
      emptyAction={emptyAction}
      focusRequestKey={focusRequestKey}
      focusRevision={props.model.sourceHash}
      onCancelPointPreview={onCancelPreview}
      onCommitPointPreview={onCommitPreview}
      onCommitReorder={onCommitReorder}
      onEditPlot={props.readonly ? undefined : onEdit}
      onEditPoint={props.readonly ? undefined : onEdit}
      onEditCategory={props.readonly ? undefined : onEdit}
      onEditAxis={props.readonly ? undefined : onEdit}
      onAxisEditorClose={onEditClose}
      onCategoryEditorClose={onEditClose}
      onPlotEditorClose={onEditClose}
      onPointEditorClose={onEditClose}
      onPreviewPoint={props.readonly ? undefined : onPreview}
      onPreviewReorder={props.readonly ? undefined : onPreviewReorder}
      onSelectPlot={onSelect}
      onSelectPoint={onSelect}
      onSelectCategory={onSelect}
      onSelectAxis={onSelect}
      orientation={
        appearancePreview?.chartOrientation ?? props.model.orientation
      }
      plotEditor={
        props.readonly
          ? undefined
          : (facadePlot, controls) => {
              const plot = props.model.plots.find(
                (candidate) => candidate.id === facadePlot.id,
              )!;
              return (
                <MermaidXyPlotPopover
                  draft={
                    editorDraft?.kind === "plot" && editorDraft.id === plot.id
                      ? editorDraft
                      : {
                          id: plot.id,
                          kind: "plot",
                          plotKind: plot.kind,
                          reorderDirection: 0,
                          title: plot.titleExplicit ? plot.title : "",
                          titleForm: plot.titleForm ?? "plain",
                        }
                  }
                  onApply={(title, titleForm, kind, direction) =>
                    onPlotApply(plot, title, titleForm, kind, direction)
                  }
                  onCancel={controls.close}
                  onDelete={() => onDelete(plot.id)}
                  onDraftChange={onEditorDraftChange}
                  onPreviewReorder={(direction) =>
                    onPreviewReorder("plot", plot.id, direction)
                  }
                  plot={plot}
                  props={props}
                />
              );
            }
      }
      plotEditorId={
        props.model.plots.some((plot) => plot.id === editingId)
          ? editingId
          : undefined
      }
      plots={plots}
      pointEditor={
        props.readonly
          ? undefined
          : (facadePoint, _plot, controls) => {
              const point = props.model.plots
                .flatMap((plot) => plot.points)
                .find((candidate) => candidate.id === facadePoint.id)!;
              const plot = props.model.plots.find(
                (candidate) => candidate.id === point.plotId,
              )!;
              return (
                <MermaidXyValuePopover
                  draft={
                    editorDraft?.kind === "point" && editorDraft.id === point.id
                      ? editorDraft
                      : {
                          id: point.id,
                          kind: "point",
                          label: point.label,
                          labelForm: point.labelForm ?? "plain",
                          reorderDirection: 0,
                          value: point.value,
                        }
                  }
                  onApply={(value, label, labelForm, direction) =>
                    onPointApply(point, value, label, labelForm, direction)
                  }
                  onCancel={controls.close}
                  onDelete={() => onDelete(point.id)}
                  onDraftChange={onEditorDraftChange}
                  onPreviewReorder={(direction) =>
                    onPreviewReorder("point", point.id, direction)
                  }
                  plot={plot}
                  point={point}
                  props={props}
                  x={
                    props.model.xAxis.effectiveKind === "band"
                      ? (props.model.xAxis.categories[point.order]?.label ??
                        props.labels.unmatchedPoint(point.order + 1))
                      : pointX(props, plot, point)
                  }
                />
              );
            }
      }
      pointEditorId={
        props.model.plots.some((plot) =>
          plot.points.some((point) => point.id === editingId),
        )
          ? editingId
          : undefined
      }
      pointKeyboardStepLabel={props.labels.valueStep}
      previewPoint={preview}
      readonly={props.readonly}
      selectedId={selectedId}
      xAxisKind={props.model.xAxis.effectiveKind}
      xAxisLabel={props.model.xAxis.title}
      xMaximum={props.model.xAxis.effectiveMaximum}
      xMinimum={props.model.xAxis.effectiveMinimum}
      yAxisLabel={props.model.yAxis.title}
      xAxisAction={
        xAxisDiagnostics.length > 0 || showComments ? (
          <Group gap="xs" wrap="nowrap">
            <XyDiagnosticMarker diagnostics={xAxisDiagnostics} />
            {showComments ? (
              <MermaidXyCommentMarker
                anchor={{ id: "xy-axis-x", kind: "x-axis" }}
                onCommand={onCommentCommand}
                props={props}
              />
            ) : null}
          </Group>
        ) : undefined
      }
      yAxisAction={
        yAxisDiagnostics.length > 0 || showComments ? (
          <Group gap="xs" wrap="nowrap">
            <XyDiagnosticMarker diagnostics={yAxisDiagnostics} />
            {showComments ? (
              <MermaidXyCommentMarker
                anchor={{ id: "xy-axis-y", kind: "y-axis" }}
                onCommand={onCommentCommand}
                props={props}
              />
            ) : null}
          </Group>
        ) : undefined
      }
      yMaximum={props.model.yAxis.maximum}
      yMinimum={props.model.yAxis.minimum}
    />
  );
}
