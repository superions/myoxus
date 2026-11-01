// SPDX-License-Identifier: AGPL-3.0-or-later

import { PieChart as MantinePieChart } from "@mantine/charts";
import {
  Button,
  Center,
  Group,
  NumberInput,
  Popover as MantinePopover,
  ScrollArea,
  Stack,
  Table,
  Text,
  TextInput,
  ThemeIcon,
  UnstyledButton,
} from "@mantine/core";
import { useElementSize } from "@mantine/hooks";
import { CommentIcon } from "@myoxus/icons/react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useId, useRef, useState } from "react";

import {
  type DNDData,
  DropIndicator,
  useDraggable,
  useDropTarget,
} from "../../dnd";
import { DragHandle } from "../../drag-handle";
import {
  DataChartShell,
  type DataChartValueFormatter,
  localizedChartNumber as localizedNumber,
} from "./chart-shell";

function activationProps(
  id: string,
  onSelect?: (id: string) => void,
  ariaLabel?: string,
  selected = false,
) {
  return {
    "aria-label": ariaLabel,
    "aria-pressed": onSelect ? selected : undefined,
    "data-chart-item-id": id,
    "data-selected": selected || undefined,
    cursor: onSelect ? "pointer" : undefined,
    onClick: () => onSelect?.(id),
    onKeyDown: (event: { key: string; preventDefault(): void }) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onSelect?.(id);
      }
    },
    role: onSelect ? "button" : undefined,
    tabIndex: onSelect ? 0 : undefined,
  };
}

export type DataPieChartItem = {
  readonly color?: string;
  readonly id: string;
  readonly issue?: string;
  readonly label: string;
  readonly value: number;
};

export type DataPieChartLegendPosition =
  "bottom" | "center" | "left" | "right" | "top";

export type DataPieChartReorder = (
  itemId: string,
  beforeItemId?: string,
) => void;

export type DataPieChartSelectionEditor = (
  item: DataPieChartItem,
  controls: { readonly close: () => void },
) => ReactNode;

export type DataPieChartProps = {
  readonly ariaLabel: string;
  readonly data: ReadonlyArray<DataPieChartItem>;
  readonly donut?: number;
  readonly diagramMarker?: ReactNode;
  readonly draftItem?: DataPieChartItem;
  readonly emptyAction?: ReactNode;
  readonly emptyLabel: string;
  readonly focusRequestKey?: number;
  readonly highlightedId?: string | "hover";
  readonly invalidLabel?: string;
  readonly labelMode?: "name" | "none" | "percent" | "value";
  readonly labelPosition?: "inside" | "outside" | number;
  readonly legendPosition?: DataPieChartLegendPosition;
  readonly legendMarker?: (item: DataPieChartItem) => ReactNode;
  readonly onHighlight?: (id: string | null) => void;
  readonly onDraftInvalidated?: () => void;
  readonly onLegendReorder?: DataPieChartReorder;
  readonly onLegendRename?: (itemId: string, label: string) => boolean | void;
  readonly onLegendSelect?: (id: string) => void;
  readonly onSelect?: (id: string) => void;
  readonly onSegmentSelect?: (id: string) => void;
  readonly reorderLabel?: string;
  readonly revision?: string;
  readonly selectionEditor?: DataPieChartSelectionEditor;
  readonly selectionEditorPosition?: "bottom" | "left" | "right" | "top";
  readonly onSelectionEditorClose?: () => void;
  readonly focusSelectedId?: string;
  readonly selectedId?: string;
  readonly showLegend?: boolean;
  readonly summary?: ReactNode;
  readonly valueFormatter?: DataChartValueFormatter;
  readonly zeroStateLabel?: string;
};

const DATA_PIE_COLORS = [
  "myoxus",
  "myoxusInfo",
  "myoxusSuccess",
  "myoxusWarning",
  "myoxusError",
] as const;

type DataPieLegendDnd = DNDData<
  {
    readonly itemId: string;
    readonly listId: string;
    readonly type: "data-pie-legend-item";
  },
  {
    readonly itemId: string;
    readonly listId: string;
    readonly type: "data-pie-legend-target";
  }
>;

function DataPieLegendItem({
  data,
  draftItemId,
  item,
  invalidLabel,
  marker,
  listId,
  onDraftInvalidated,
  onReorder,
  onRename,
  onReorderPreview,
  onReorderPreviewEnd,
  onSelect,
  onSelectionEditorClose,
  reorderLabel,
  reorderDisabled,
  revision,
  focusRequestKey,
  focusSelected,
  selected,
  selectionEditor,
  selectionEditorPosition,
  valueFormatter,
}: {
  readonly data: ReadonlyArray<DataPieChartItem>;
  readonly draftItemId?: string;
  readonly item: DataPieChartItem;
  readonly invalidLabel?: string;
  readonly marker?: ReactNode;
  readonly listId: string;
  readonly onDraftInvalidated?: () => void;
  readonly onReorder?: DataPieChartReorder;
  readonly onRename?: (itemId: string, label: string) => boolean | void;
  readonly onReorderPreview?: DataPieChartReorder;
  readonly onReorderPreviewEnd?: () => void;
  readonly onSelect?: (id: string) => void;
  readonly onSelectionEditorClose?: () => void;
  readonly reorderLabel?: string;
  readonly reorderDisabled: boolean;
  readonly revision?: string;
  readonly focusRequestKey?: number;
  readonly focusSelected: boolean;
  readonly selected: boolean;
  readonly selectionEditor?: DataPieChartSelectionEditor;
  readonly selectionEditorPosition?: "bottom" | "left" | "right" | "top";
  readonly valueFormatter: DataChartValueFormatter;
}) {
  const [renaming, setRenaming] = useState(false);
  const [labelDraft, setLabelDraft] = useState(item.label);
  const [renameInvalid, setRenameInvalid] = useState(false);
  const controlRef = useRef<HTMLButtonElement>(null);
  const handledFocusRequestRef = useRef<number | undefined>(undefined);
  const revisionRef = useRef(revision);
  useEffect(() => {
    if (!renaming) setLabelDraft(item.label);
  }, [item.label, renaming]);
  useEffect(() => {
    if (
      focusSelected &&
      focusRequestKey !== undefined &&
      handledFocusRequestRef.current !== focusRequestKey &&
      !renaming &&
      !selectionEditor
    ) {
      handledFocusRequestRef.current = focusRequestKey;
      queueMicrotask(() => controlRef.current?.focus());
    }
  }, [focusRequestKey, focusSelected, renaming, selectionEditor]);
  useEffect(() => {
    if (revisionRef.current === revision) return;
    revisionRef.current = revision;
    if (!renaming) return;
    setLabelDraft(item.label);
    setRenaming(false);
    onDraftInvalidated?.();
  }, [item.label, onDraftInvalidated, renaming, revision]);
  const { dragHandleRef, dragRef, dragging } = useDraggable<DataPieLegendDnd>(
    () => ({
      canDrag: Boolean(onReorder) && !reorderDisabled,
      data: {
        itemId: item.id,
        listId,
        type: "data-pie-legend-item",
      },
      onDrop: onReorderPreviewEnd,
    }),
    [item.id, listId, onReorder, onReorderPreviewEnd, reorderDisabled],
  );
  const { closestEdge, dropTargetRef } = useDropTarget<DataPieLegendDnd>(
    () => ({
      canDrop: ({ source }) =>
        Boolean(onReorder) &&
        source.data.type === "data-pie-legend-item" &&
        source.data.listId === listId &&
        item.id !== draftItemId &&
        source.data.itemId !== item.id,
      closestEdge: { allowedEdges: ["top", "bottom"] },
      data: {
        itemId: item.id,
        listId,
        type: "data-pie-legend-target",
      },
      onDrop: ({ closestEdge: edge, source }) => {
        if (!onReorder || source.data.type !== "data-pie-legend-item") return;
        const targetIndex = data.indexOf(item);
        const beforeItemId =
          edge === "top"
            ? item.id
            : data[targetIndex + 1]?.id === draftItemId
              ? undefined
              : data[targetIndex + 1]?.id;
        onReorder(source.data.itemId, beforeItemId);
        onReorderPreviewEnd?.();
      },
      onDrag: ({ closestEdge: edge, source }) => {
        if (!onReorderPreview || source.data.type !== "data-pie-legend-item") {
          return;
        }
        const targetIndex = data.indexOf(item);
        onReorderPreview(
          source.data.itemId,
          edge === "top"
            ? item.id
            : data[targetIndex + 1]?.id === draftItemId
              ? undefined
              : data[targetIndex + 1]?.id,
        );
      },
    }),
    [
      data,
      item,
      draftItemId,
      listId,
      onReorder,
      onReorderPreview,
      onReorderPreviewEnd,
    ],
  );
  const setRowRef = (element: HTMLDivElement | null) => {
    dragRef.current = element;
    dropTargetRef.current = element;
  };
  const keyboardReorder = (delta: -1 | 1) => {
    if (!onReorder) return;
    const index = data.indexOf(item);
    const target = index + delta;
    if (
      target < 0 ||
      target >= data.length ||
      data[target].id === draftItemId
    ) {
      return;
    }
    const beforeItemId =
      delta < 0
        ? data[target].id
        : data[target + 1]?.id === draftItemId
          ? undefined
          : data[target + 1]?.id;
    onReorder(item.id, beforeItemId);
  };
  const cancelRename = () => {
    setLabelDraft(item.label);
    setRenameInvalid(false);
    setRenaming(false);
    queueMicrotask(() => controlRef.current?.focus());
  };
  const confirmRename = () => {
    const nextLabel = labelDraft.trim();
    if (!nextLabel) {
      setRenameInvalid(true);
      return;
    }
    if (nextLabel !== item.label && onRename?.(item.id, nextLabel) === false) {
      setRenameInvalid(true);
      return;
    }
    setRenameInvalid(false);
    setRenaming(false);
    queueMicrotask(() => controlRef.current?.focus());
  };
  const legendContent = (
    <>
      <ThemeIcon
        aria-hidden
        className="myoxus-data-pie-legend-swatch"
        color={item.color}
        size="xs"
        variant="filled"
      />
      <Text component="span" title={item.label}>
        {item.label}
      </Text>
      <Text c="dimmed" component="span">
        {valueFormatter(item.value)}
      </Text>
    </>
  );
  const control = renaming ? (
    <TextInput
      autoFocus
      aria-label={item.label}
      className="myoxus-data-pie-legend-rename"
      error={renameInvalid ? invalidLabel : undefined}
      onBlur={cancelRename}
      onChange={(event) => setLabelDraft(event.currentTarget.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          confirmRename();
        } else if (event.key === "Escape") {
          event.preventDefault();
          cancelRename();
        }
      }}
      value={labelDraft}
    />
  ) : onSelect || onRename ? (
    <UnstyledButton
      ref={controlRef}
      aria-label={`${item.label}: ${valueFormatter(item.value)}`}
      aria-pressed={onSelect ? selected : undefined}
      className="myoxus-data-pie-legend-control"
      data-chart-item-id={item.id}
      onClick={() => onSelect?.(item.id)}
      onDoubleClick={() => {
        if (onRename) setRenaming(true);
      }}
      onKeyDown={(event) => {
        if (event.key === "F2" && onRename) {
          event.preventDefault();
          setRenaming(true);
        }
      }}
      type="button"
    >
      {legendContent}
    </UnstyledButton>
  ) : (
    <div className="myoxus-data-pie-legend-control">{legendContent}</div>
  );
  return (
    <div
      ref={setRowRef}
      className="myoxus-data-pie-legend-item"
      data-dragging={dragging ? "true" : undefined}
      data-selected={selected ? "true" : undefined}
      role="listitem"
    >
      <DropIndicator edge={closestEdge} />
      {onReorder ? (
        <DragHandle
          ref={dragHandleRef}
          aria-label={reorderLabel}
          dragging={dragging}
          disabled={reorderDisabled}
          keyboardMoveModifier="alt"
          keyboardMoveOrientation="vertical"
          onKeyboardMove={keyboardReorder}
        />
      ) : null}
      {selected && selectionEditor ? (
        <MantinePopover
          opened
          onChange={(opened) => {
            if (!opened) onSelectionEditorClose?.();
          }}
          position={selectionEditorPosition}
          returnFocus
          trapFocus
        >
          <MantinePopover.Target>{control}</MantinePopover.Target>
          <MantinePopover.Dropdown>
            {selectionEditor(item, {
              close: () => onSelectionEditorClose?.(),
            })}
          </MantinePopover.Dropdown>
        </MantinePopover>
      ) : (
        control
      )}
      {marker}
      {item.issue ? (
        <Text
          c="myoxusError"
          className="myoxus-data-pie-legend-issue"
          role="status"
          size="xs"
        >
          {item.issue}
        </Text>
      ) : null}
    </div>
  );
}

function DataPieLegend({
  data,
  draftItemId,
  focusRequestKey,
  focusSelectedId,
  invalidLabel,
  legendMarker,
  onDraftInvalidated,
  onReorder,
  onReorderPreview,
  onReorderPreviewEnd,
  onRename,
  onSelect,
  onSelectionEditorClose,
  reorderLabel,
  revision,
  selectedId,
  selectionEditor,
  selectionEditorPosition,
  valueFormatter,
}: {
  readonly data: ReadonlyArray<DataPieChartItem>;
  readonly draftItemId?: string;
  readonly focusRequestKey?: number;
  readonly focusSelectedId?: string;
  readonly invalidLabel?: string;
  readonly legendMarker?: (item: DataPieChartItem) => ReactNode;
  readonly onDraftInvalidated?: () => void;
  readonly onReorder?: DataPieChartReorder;
  readonly onReorderPreview?: DataPieChartReorder;
  readonly onReorderPreviewEnd?: () => void;
  readonly onRename?: (itemId: string, label: string) => boolean | void;
  readonly onSelect?: (id: string) => void;
  readonly onSelectionEditorClose?: () => void;
  readonly reorderLabel?: string;
  readonly revision?: string;
  readonly selectedId?: string;
  readonly selectionEditor?: DataPieChartSelectionEditor;
  readonly selectionEditorPosition?: "bottom" | "left" | "right" | "top";
  readonly valueFormatter: DataChartValueFormatter;
}) {
  const listId = useId();
  return (
    <Stack className="myoxus-data-pie-legend" gap="xs" role="list">
      {data.map((item) => (
        <DataPieLegendItem
          data={data}
          draftItemId={draftItemId}
          item={item}
          invalidLabel={invalidLabel}
          key={item.id}
          listId={listId}
          marker={legendMarker?.(item)}
          focusRequestKey={focusRequestKey}
          focusSelected={item.id === focusSelectedId}
          onReorder={onReorder}
          onDraftInvalidated={onDraftInvalidated}
          onReorderPreview={onReorderPreview}
          onReorderPreviewEnd={onReorderPreviewEnd}
          onRename={onRename}
          onSelect={onSelect}
          onSelectionEditorClose={onSelectionEditorClose}
          reorderLabel={reorderLabel}
          reorderDisabled={item.id === draftItemId}
          revision={revision}
          selected={item.id === selectedId}
          selectionEditor={selectionEditor}
          selectionEditorPosition={selectionEditorPosition}
          valueFormatter={valueFormatter}
        />
      ))}
    </Stack>
  );
}

export function DataPieChart({
  ariaLabel,
  data,
  diagramMarker,
  donut = 0,
  draftItem,
  emptyAction,
  emptyLabel,
  focusRequestKey,
  highlightedId,
  invalidLabel,
  labelMode = "name",
  labelPosition = "outside",
  legendPosition = "bottom",
  legendMarker,
  onHighlight,
  onDraftInvalidated,
  onLegendReorder,
  onLegendRename,
  onLegendSelect,
  onSelect,
  onSegmentSelect,
  onSelectionEditorClose,
  focusSelectedId,
  reorderLabel,
  revision,
  selectedId,
  selectionEditor,
  selectionEditorPosition,
  showLegend = true,
  summary,
  valueFormatter,
  zeroStateLabel,
}: DataPieChartProps) {
  const [reorderPreview, setReorderPreview] = useState<{
    readonly beforeItemId?: string;
    readonly itemId: string;
  } | null>(null);
  const {
    height: chartHeight,
    ref: chartRef,
    width: chartWidth,
  } = useElementSize<HTMLDivElement>();
  const chartSize = Math.floor(Math.min(chartWidth, chartHeight));
  const resolvedSelectionEditorPosition =
    selectionEditorPosition ??
    (legendPosition === "right"
      ? "left"
      : legendPosition === "left"
        ? "right"
        : legendPosition === "top"
          ? "bottom"
          : "top");
  const formatValue = valueFormatter ?? localizedNumber;
  const numericLabelPosition =
    typeof labelPosition === "number"
      ? Math.max(0, Math.min(1, labelPosition))
      : null;
  const innerRadius = (chartSize / 2) * Math.max(0, Math.min(0.9, donut));
  const selectSegment = onSegmentSelect ?? onSelect;
  const selectLegend = onLegendSelect ?? onSelect;
  const baseData = draftItem ? [...data, draftItem] : data;
  const previewData = reorderPreview
    ? (() => {
        const next = baseData.filter(
          (item) => item.id !== reorderPreview.itemId,
        );
        const moved = baseData.find(
          (item) => item.id === reorderPreview.itemId,
        );
        if (!moved) return baseData;
        const targetIndex = reorderPreview.beforeItemId
          ? next.findIndex((item) => item.id === reorderPreview.beforeItemId)
          : next.length;
        if (targetIndex < 0) return baseData;
        next.splice(targetIndex, 0, moved);
        return next;
      })()
    : baseData;
  const chartData = previewData.flatMap((item, index) =>
    Number.isFinite(item.value) && item.value >= 0
      ? [
          {
            color:
              item.color ?? DATA_PIE_COLORS[index % DATA_PIE_COLORS.length],
            key: item.id,
            name: item.label,
            value: item.value,
          },
        ]
      : [],
  );
  const legendData = baseData.map((item, index) => ({
    ...item,
    color: item.color ?? DATA_PIE_COLORS[index % DATA_PIE_COLORS.length],
    issue:
      item.issue ??
      (!Number.isFinite(item.value) || item.value < 0
        ? invalidLabel
        : undefined),
  }));
  const zeroValues =
    chartData.length > 0 && chartData.every((item) => item.value === 0);
  return (
    <DataChartShell
      ariaLabel={ariaLabel}
      empty={baseData.length === 0}
      emptyAction={emptyAction}
      emptyLabel={emptyLabel}
      summary={summary}
      selectedId={selectedId}
      testId="data-pie-chart"
    >
      <div
        className="myoxus-data-pie-layout"
        data-legend-position={legendPosition}
      >
        <div
          ref={chartRef}
          className="myoxus-data-pie-chart-surface"
          data-highlight-on-hover={highlightedId === "hover" || undefined}
        >
          {diagramMarker ? (
            <div className="myoxus-data-pie-chart-marker">{diagramMarker}</div>
          ) : null}
          {zeroValues && zeroStateLabel ? (
            <Center className="myoxus-data-pie-zero-state">
              <Text c="dimmed">{zeroStateLabel}</Text>
            </Center>
          ) : chartSize > 0 ? (
            <MantinePieChart
              accessibilityLayer
              data={chartData}
              labelsPosition={
                numericLabelPosition === null &&
                typeof labelPosition !== "number"
                  ? labelPosition
                  : "inside"
              }
              labelsType={labelMode === "none" ? "name" : labelMode}
              pieProps={{
                innerRadius,
                label:
                  numericLabelPosition === null
                    ? undefined
                    : ({
                        cx,
                        cy,
                        innerRadius,
                        midAngle,
                        name,
                        outerRadius,
                        percent,
                        value,
                      }: {
                        readonly cx?: number | string;
                        readonly cy?: number | string;
                        readonly innerRadius?: number | string;
                        readonly midAngle?: number;
                        readonly name?: string;
                        readonly outerRadius?: number | string;
                        readonly percent?: number;
                        readonly value?: number;
                      }) => {
                        const radians = ((midAngle ?? 0) * Math.PI) / 180;
                        const radius =
                          Number(innerRadius) +
                          (Number(outerRadius) - Number(innerRadius)) *
                            numericLabelPosition;
                        const x = Number(cx) + radius * Math.cos(-radians);
                        const y = Number(cy) + radius * Math.sin(-radians);
                        const label =
                          labelMode === "name"
                            ? name
                            : labelMode === "percent"
                              ? `${((percent ?? 0) * 100).toFixed(0)}%`
                              : formatValue(value ?? 0);
                        return (
                          <text
                            className="myoxus-data-pie-label"
                            dominantBaseline="central"
                            fontFamily="var(--mantine-font-family)"
                            textAnchor="middle"
                            x={x}
                            y={y}
                          >
                            {label}
                          </text>
                        );
                      },
                labelLine: numericLabelPosition === null ? undefined : false,
              }}
              size={chartSize}
              tooltipDataSource="segment"
              valueFormatter={formatValue}
              withLabels={labelMode !== "none"}
              withLegend={false}
              withTooltip
              cellProps={(cell) => {
                const id = String(cell.key);
                return {
                  ...activationProps(
                    id,
                    selectSegment,
                    `${cell.name}: ${formatValue(cell.value)}`,
                    id === selectedId,
                  ),
                  "data-highlighted":
                    highlightedId !== "hover" && id === highlightedId
                      ? "true"
                      : undefined,
                  onMouseEnter: () => {
                    onHighlight?.(id);
                  },
                  onMouseLeave: () => {
                    onHighlight?.(null);
                  },
                };
              }}
            />
          ) : null}
        </div>
        {showLegend ? (
          <DataPieLegend
            data={legendData}
            draftItemId={draftItem?.id}
            focusRequestKey={focusRequestKey}
            focusSelectedId={focusSelectedId}
            invalidLabel={invalidLabel}
            legendMarker={legendMarker}
            onDraftInvalidated={onDraftInvalidated}
            onReorder={onLegendReorder}
            onReorderPreview={(itemId, beforeItemId) =>
              setReorderPreview({ beforeItemId, itemId })
            }
            onReorderPreviewEnd={() => setReorderPreview(null)}
            onRename={onLegendRename}
            onSelect={selectLegend}
            onSelectionEditorClose={onSelectionEditorClose}
            reorderLabel={reorderLabel}
            revision={revision}
            selectedId={selectedId}
            selectionEditor={selectionEditor}
            selectionEditorPosition={resolvedSelectionEditorPosition}
            valueFormatter={formatValue}
          />
        ) : null}
      </div>
    </DataChartShell>
  );
}

export type DataChartCommentItem = {
  readonly id: string;
  readonly text: string;
};

export type DataChartCommentMarkerProps = {
  readonly addLabel: string;
  readonly applyLabel: string;
  readonly deleteLabel: string;
  readonly invalidLabel: string;
  readonly items: ReadonlyArray<DataChartCommentItem>;
  readonly label: string;
  readonly onAdd: (text: string) => boolean | void;
  readonly onDelete: (id: string) => boolean | void;
  readonly onDraftInvalidated?: () => void;
  readonly onUpdate: (id: string, text: string) => boolean | void;
  readonly revision?: string;
  readonly readonly?: boolean;
};

function dataChartCommentValues(items: ReadonlyArray<DataChartCommentItem>) {
  return Object.fromEntries(items.map((item) => [item.id, item.text]));
}

export function DataChartCommentMarker({
  addLabel,
  applyLabel,
  deleteLabel,
  invalidLabel,
  items,
  label,
  onAdd,
  onDelete,
  onDraftInvalidated,
  onUpdate,
  revision,
  readonly = false,
}: DataChartCommentMarkerProps) {
  const incoming = JSON.stringify(dataChartCommentValues(items));
  const [opened, setOpened] = useState(false);
  const [newComment, setNewComment] = useState("");
  const [invalid, setInvalid] = useState(false);
  const [values, setValues] = useState<Record<string, string>>(() =>
    dataChartCommentValues(items),
  );
  const revisionRef = useRef(revision);
  useEffect(() => setValues(JSON.parse(incoming)), [incoming]);
  const close = useCallback(() => {
    setOpened(false);
    setInvalid(false);
    setNewComment("");
    setValues(JSON.parse(incoming));
  }, [incoming]);
  const count = localizedNumber(items.length);
  const triggerLabel = `${label}: ${count}`;
  useEffect(() => {
    if (revisionRef.current === revision) return;
    revisionRef.current = revision;
    if (!opened) return;
    close();
    onDraftInvalidated?.();
  }, [close, onDraftInvalidated, opened, revision]);
  if (readonly && items.length === 0) return null;
  return (
    <MantinePopover
      opened={opened}
      onChange={(nextOpened) => (nextOpened ? setOpened(true) : close())}
      returnFocus
      trapFocus
    >
      <MantinePopover.Target>
        <Button
          aria-label={triggerLabel}
          leftSection={<CommentIcon />}
          onClick={() => (opened ? close() : setOpened(true))}
          variant="subtle"
        >
          {count}
        </Button>
      </MantinePopover.Target>
      <MantinePopover.Dropdown>
        <Stack gap="xs">
          {items.map((item) => (
            <Stack gap="xs" key={item.id}>
              {readonly ? (
                <Text>{item.text}</Text>
              ) : (
                <>
                  <TextInput
                    aria-label={label}
                    onChange={(event) => {
                      const value = event.currentTarget.value;
                      setValues((current) => ({
                        ...current,
                        [item.id]: value,
                      }));
                    }}
                    value={values[item.id] ?? item.text}
                  />
                  <Group justify="flex-end" wrap="nowrap">
                    <Button
                      onClick={() => {
                        const changed = onDelete(item.id) !== false;
                        setInvalid(!changed);
                        if (changed) close();
                      }}
                      variant="subtle"
                    >
                      {deleteLabel}
                    </Button>
                    <Button
                      disabled={!(values[item.id] ?? item.text).trim()}
                      onClick={() => {
                        const text = (values[item.id] ?? item.text).trim();
                        if (text === item.text) {
                          setInvalid(false);
                          return;
                        }
                        const changed = onUpdate(item.id, text) !== false;
                        setInvalid(!changed);
                        if (changed) close();
                      }}
                    >
                      {applyLabel}
                    </Button>
                  </Group>
                </>
              )}
            </Stack>
          ))}
          {readonly ? null : (
            <>
              <TextInput
                aria-label={addLabel}
                onChange={(event) => setNewComment(event.currentTarget.value)}
                value={newComment}
              />
              <Button
                disabled={!newComment.trim()}
                onClick={() => {
                  const changed = onAdd(newComment) !== false;
                  setInvalid(!changed);
                  if (changed) close();
                }}
              >
                {addLabel}
              </Button>
            </>
          )}
          {invalid ? (
            <Text c="myoxusError" role="alert">
              {invalidLabel}
            </Text>
          ) : null}
        </Stack>
      </MantinePopover.Dropdown>
    </MantinePopover>
  );
}

export type DataChartValueEditorProps = {
  readonly invalidLabel?: string;
  readonly items: ReadonlyArray<{
    readonly id: string;
    readonly issue?: string;
    readonly label: string;
    readonly value: number;
  }>;
  readonly label: string;
  readonly labelColumn: string;
  readonly addLabel?: string;
  readonly deleteLabel?: string;
  readonly onAdd?: () => void;
  readonly onDelete?: (id: string) => void;
  readonly onLabelChange: (id: string, label: string) => boolean | void;
  readonly onReorder: DataPieChartReorder;
  readonly onSelect: (id: string) => void;
  readonly onValueChange: (id: string, value: number) => boolean | void;
  readonly readonly: boolean;
  readonly reorderLabel: string;
  readonly selectedId?: string;
  readonly valueColumn: string;
};

type DataChartValueEditorDnd = DNDData<
  {
    readonly itemId: string;
    readonly listId: string;
    readonly type: "data-chart-value-item";
  },
  {
    readonly itemId: string;
    readonly listId: string;
    readonly type: "data-chart-value-target";
  }
>;

function DataChartValueEditorRow({
  deleteLabel,
  item,
  items,
  invalidLabel,
  labelColumn,
  listId,
  onDelete,
  onLabelChange,
  onReorder,
  onSelect,
  onValueChange,
  readonly,
  reorderLabel,
  selected,
  valueColumn,
}: {
  readonly deleteLabel?: string;
  readonly item: DataChartValueEditorProps["items"][number];
  readonly items: DataChartValueEditorProps["items"];
  readonly invalidLabel?: string;
  readonly labelColumn: string;
  readonly listId: string;
  readonly onDelete?: (id: string) => void;
  readonly onLabelChange: (id: string, label: string) => boolean | void;
  readonly onReorder: DataPieChartReorder;
  readonly onSelect: (id: string) => void;
  readonly onValueChange: (id: string, value: number) => boolean | void;
  readonly readonly: boolean;
  readonly reorderLabel: string;
  readonly selected: boolean;
  readonly valueColumn: string;
}) {
  const [labelDraft, setLabelDraft] = useState(item.label);
  const [valueDraft, setValueDraft] = useState<number | string>(item.value);
  const [labelInvalid, setLabelInvalid] = useState(false);
  const [valueInvalid, setValueInvalid] = useState(false);
  useEffect(() => {
    setLabelDraft(item.label);
    setValueDraft(item.value);
    setLabelInvalid(false);
    setValueInvalid(false);
  }, [item.label, item.value]);
  const applyLabel = () => {
    const label = labelDraft.trim();
    if (!label) {
      setLabelInvalid(true);
      return;
    }
    if (label !== item.label && onLabelChange(item.id, label) === false) {
      setLabelInvalid(true);
      return;
    }
    setLabelInvalid(false);
  };
  const applyValue = () => {
    if (
      typeof valueDraft !== "number" ||
      !Number.isFinite(valueDraft) ||
      valueDraft < 0
    ) {
      setValueInvalid(true);
      return;
    }
    if (
      valueDraft !== item.value &&
      onValueChange(item.id, valueDraft) === false
    ) {
      setValueInvalid(true);
      return;
    }
    setValueInvalid(false);
  };
  const { dragHandleRef, dragRef, dragging } =
    useDraggable<DataChartValueEditorDnd>(
      () => ({
        canDrag: !readonly,
        data: {
          itemId: item.id,
          listId,
          type: "data-chart-value-item",
        },
      }),
      [item.id, listId, readonly],
    );
  const { closestEdge, dropTargetRef } = useDropTarget<DataChartValueEditorDnd>(
    () => ({
      canDrop: ({ source }) =>
        !readonly &&
        source.data.type === "data-chart-value-item" &&
        source.data.listId === listId &&
        source.data.itemId !== item.id,
      closestEdge: { allowedEdges: ["top", "bottom"] },
      data: {
        itemId: item.id,
        listId,
        type: "data-chart-value-target",
      },
      onDrop: ({ closestEdge: edge, source }) => {
        if (source.data.type !== "data-chart-value-item") return;
        const targetIndex = items.indexOf(item);
        onReorder(
          source.data.itemId,
          edge === "top" ? item.id : items[targetIndex + 1]?.id,
        );
      },
    }),
    [item, items, listId, onReorder, readonly],
  );
  const setRowRef = (element: HTMLTableRowElement | null) => {
    dragRef.current = element;
    dropTargetRef.current = element;
  };
  const keyboardReorder = (delta: -1 | 1) => {
    const index = items.indexOf(item);
    const target = index + delta;
    if (target < 0 || target >= items.length) return;
    onReorder(item.id, delta < 0 ? items[target].id : items[target + 1]?.id);
  };
  return (
    <Table.Tr
      ref={setRowRef}
      className="myoxus-data-chart-editor-row"
      data-dragging={dragging ? "true" : undefined}
      data-drop-edge={closestEdge ?? undefined}
      data-selected={selected ? "true" : undefined}
      onClick={() => onSelect(item.id)}
    >
      <Table.Td>
        <Stack gap="xs">
          <TextInput
            aria-label={`${labelColumn}: ${item.label}`}
            disabled={readonly}
            error={labelInvalid ? invalidLabel : undefined}
            onBlur={applyLabel}
            onChange={(event) => {
              setLabelDraft(event.currentTarget.value);
              setLabelInvalid(!event.currentTarget.value.trim());
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") applyLabel();
              else if (event.key === "Escape") {
                setLabelDraft(item.label);
                setLabelInvalid(false);
              }
            }}
            value={labelDraft}
          />
          {item.issue ? (
            <Text c="myoxusError" role="status" size="xs">
              {item.issue}
            </Text>
          ) : null}
        </Stack>
      </Table.Td>
      <Table.Td>
        <NumberInput
          aria-label={`${valueColumn}: ${item.label}`}
          disabled={readonly}
          error={valueInvalid ? invalidLabel : undefined}
          min={0}
          onBlur={applyValue}
          onChange={(value) => {
            setValueDraft(value);
            setValueInvalid(
              typeof value !== "number" || !Number.isFinite(value) || value < 0,
            );
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") applyValue();
            else if (event.key === "Escape") {
              setValueDraft(item.value);
              setValueInvalid(false);
            }
          }}
          value={valueDraft}
        />
      </Table.Td>
      <Table.Td>
        <Group justify="flex-end" wrap="nowrap">
          <DragHandle
            ref={dragHandleRef}
            aria-label={reorderLabel}
            disabled={readonly}
            dragging={dragging}
            keyboardMoveModifier="alt"
            keyboardMoveOrientation="vertical"
            onKeyboardMove={keyboardReorder}
          />
          {onDelete && deleteLabel ? (
            <Button
              disabled={readonly}
              onClick={(event) => {
                event.stopPropagation();
                onDelete(item.id);
              }}
              variant="subtle"
            >
              {deleteLabel}
            </Button>
          ) : null}
        </Group>
      </Table.Td>
    </Table.Tr>
  );
}

export function DataChartValueEditor({
  addLabel,
  deleteLabel,
  items,
  invalidLabel,
  label,
  labelColumn,
  onAdd,
  onDelete,
  onLabelChange,
  onReorder,
  onSelect,
  onValueChange,
  readonly,
  reorderLabel,
  selectedId,
  valueColumn,
}: DataChartValueEditorProps) {
  const listId = useId();
  return (
    <Stack gap="xs">
      {onAdd && addLabel ? (
        <Group justify="flex-end">
          <Button disabled={readonly} onClick={onAdd}>
            {addLabel}
          </Button>
        </Group>
      ) : null}
      <ScrollArea type="auto">
        <Table aria-label={label} striped withTableBorder>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>{labelColumn}</Table.Th>
              <Table.Th>{valueColumn}</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {items.map((item) => (
              <DataChartValueEditorRow
                deleteLabel={deleteLabel}
                item={item}
                items={items}
                invalidLabel={invalidLabel}
                key={item.id}
                labelColumn={labelColumn}
                listId={listId}
                onDelete={onDelete}
                onLabelChange={onLabelChange}
                onReorder={onReorder}
                onSelect={onSelect}
                onValueChange={onValueChange}
                readonly={readonly}
                reorderLabel={reorderLabel}
                selected={selectedId === item.id}
                valueColumn={valueColumn}
              />
            ))}
          </Table.Tbody>
        </Table>
      </ScrollArea>
    </Stack>
  );
}
