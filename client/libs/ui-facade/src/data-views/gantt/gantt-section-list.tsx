// SPDX-License-Identifier: AGPL-3.0-or-later

import { ActionIcon, Box, Group, Table, Text, Tooltip } from "@mantine/core";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  GripVerticalIcon,
  LinkIcon,
} from "@myoxus/icons/react";
import {
  Fragment,
  type KeyboardEvent,
  type PointerEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import {
  GANTT_AXIS_HEADER_HEIGHT,
  GANTT_ROW_HEIGHT,
  GANTT_SECTION_HEADER_HEIGHT,
  ganttLayout,
} from "./geometry";
import type {
  GanttCapability,
  GanttMetadataColumnView,
  GanttSectionView,
  GanttListRowView,
} from "./gantt-view";

/** Pinned left column: section headers plus one label row per task. */
export function GanttSectionList({
  labels,
  intrinsicLabels = false,
  metadataColumns = [],
  rowHeight = GANTT_ROW_HEIGHT,
  headerHeight = GANTT_AXIS_HEADER_HEIGHT,
  onMeasureRows,
  onMeasureHeader,
  onReorderSection,
  onReorderTask,
  onSelectSection,
  onToggleSection,
  readonly,
  reorder,
  onRenameTask,
  onOpenTask,
  onDeleteTask,
  onSelectTask,
  onConnectTask,
  rows,
  sections,
  selectedSectionId,
  selectedTaskId,
}: {
  labels: {
    reorderSection: string;
    reorderTask: string;
    row?: string;
    connectTask?: string;
  };
  metadataColumns?: readonly GanttMetadataColumnView[];
  intrinsicLabels?: boolean;
  rowHeight?: number;
  headerHeight?: number;
  onMeasureRows?: (height: number) => void;
  onMeasureHeader?: (height: number) => void;
  onReorderSection: (sectionId: string, targetOrder: number) => void;
  onReorderTask: (
    taskId: string,
    targetSectionId: string,
    targetOrder: number,
  ) => void;
  onSelectSection?: (sectionId: string) => void;
  onToggleSection?: (sectionId: string, collapsed: boolean) => void;
  readonly: boolean;
  reorder?: { sections: GanttCapability; tasks: GanttCapability };
  onRenameTask?: (taskId: string) => void;
  onOpenTask?: (taskId: string) => void;
  onDeleteTask?: (taskId: string) => void;
  onSelectTask?: (taskId: string) => void;
  onConnectTask?: (taskId: string) => void;
  rows: readonly { section: GanttSectionView; task: GanttListRowView }[];
  sections: readonly GanttSectionView[];
  selectedTaskId: string | null;
  selectedSectionId?: string | null;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const connectionEndpoint = (task: GanttListRowView) =>
    !readonly &&
    (task.selected ?? task.id === selectedTaskId) &&
    task.connectEndpoint?.enabled ? (
      <Tooltip label={labels.connectTask}>
        <ActionIcon
          aria-label={labels.connectTask}
          data-testid={`gantt-connect-${task.id}`}
          variant="subtle"
          onPointerDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onConnectTask?.(task.id);
          }}
        >
          <LinkIcon />
        </ActionIcon>
      </Tooltip>
    ) : null;
  const measurementKey = JSON.stringify([
    intrinsicLabels,
    metadataColumns.map((column) => column.id),
    rows.map((row) => [row.task.id, Boolean(row.task.notice)]),
  ]);
  useLayoutEffect(() => {
    if (
      !intrinsicLabels &&
      !metadataColumns.length &&
      !rows.some((row) => row.task.notice)
    ) {
      onMeasureRows?.(GANTT_ROW_HEIGHT);
      onMeasureHeader?.(GANTT_AXIS_HEADER_HEIGHT);
      return;
    }
    const root = rootRef.current;
    if (!root) return;
    // Measure intrinsic content, never the imposed row box. This prevents a
    // resize feedback loop and keeps labels, hit areas and edges on one layout.
    const probes = [
      ...root.querySelectorAll<HTMLElement>(
        '[data-myoxus-ui-role="gantt-intrinsic-cell"]',
      ),
    ];
    const headers = [
      ...root.querySelectorAll<HTMLElement>(
        '[data-myoxus-ui-role="gantt-intrinsic-header"]',
      ),
    ];
    const intrinsicHeight = (probe: HTMLElement) => {
      const cell = probe.parentElement;
      const style = cell ? getComputedStyle(cell) : null;
      const rowStyle = cell?.parentElement
        ? getComputedStyle(cell.parentElement)
        : null;
      return Math.ceil(
        probe.getBoundingClientRect().height +
          (style
            ? parseFloat(style.paddingBlockStart) +
              parseFloat(style.paddingBlockEnd) +
              parseFloat(style.borderBlockEndWidth) +
              (rowStyle ? parseFloat(rowStyle.borderBlockEndWidth) : 0)
            : 0),
      );
    };
    const measure = () => {
      onMeasureRows?.(
        Math.max(GANTT_ROW_HEIGHT, ...probes.map(intrinsicHeight)),
      );
      onMeasureHeader?.(
        Math.max(GANTT_AXIS_HEADER_HEIGHT, ...headers.map(intrinsicHeight)),
      );
    };
    const observer = new ResizeObserver(measure);
    probes.forEach((probe) => observer.observe(probe));
    headers.forEach((header) => observer.observe(header));
    measure();
    return () => observer.disconnect();
  }, [measurementKey, onMeasureRows, onMeasureHeader]);
  type ReorderDraft = {
    kind: "section" | "task";
    id: string;
    sectionId: string;
    order: number;
  };
  const [preview, setPreview] = useState<ReorderDraft | null>(null);
  // Selection/viewport reprojection creates new arrays without changing the
  // reorder inputs. Only actual content/order changes revoke a live gesture.
  const reorderRevision = JSON.stringify([
    sections.map(({ id, label, order }) => [id, label, order]),
    rows.map(({ section, task }) => [
      section.id,
      task.id,
      task.sectionId,
      task.label,
      "start" in task ? task.start : null,
      "end" in task ? task.end : null,
      "milestone" in task ? task.milestone : null,
      task.statuses,
    ]),
  ]);
  useEffect(() => {
    setPreview(null);
    dragRef.current = null;
  }, [readonly, reorderRevision]);
  const commit = (draft: ReorderDraft) => {
    if (readonly) return;
    if (draft.kind === "section") onReorderSection(draft.id, draft.order);
    else onReorderTask(draft.id, draft.sectionId, draft.order);
    setPreview(null);
  };
  const cancel = () => {
    dragRef.current = null;
    setPreview(null);
  };
  const dragRef = useRef<{
    kind: "section" | "task";
    id: string;
    sectionId: string;
    startY: number;
  } | null>(null);
  const beginDrag = (
    event: PointerEvent,
    entry: {
      kind: "section" | "task";
      id: string;
      sectionId: string;
    },
  ) => {
    if (readonly) return;
    event.stopPropagation();
    try {
      (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    } catch {
      /* best effort */
    }
    dragRef.current = { ...entry, startY: event.clientY };
  };
  // The prospective order is read from the rendered row rectangles, so a
  // pointer drag and an Alt+Arrow step resolve to the same target order.
  const dragTarget = (event: PointerEvent): ReorderDraft | null => {
    const started = dragRef.current;
    if (!started || readonly) return null;
    if (Math.abs(event.clientY - started.startY) < 8) return null;
    // Scope to this surface only, so a foreign block's rows can never become
    // a reorder target.
    const rows = Array.from(
      rootRef.current?.querySelectorAll<HTMLElement>(
        '[data-myoxus-ui-role="gantt-row-label"], [data-myoxus-ui-role="gantt-section-header"]',
      ) ?? [],
    );
    let hit = rows.findIndex((row) => {
      const rect = row.getBoundingClientRect();
      return event.clientY >= rect.top && event.clientY < rect.bottom;
    });
    if (hit < 0) {
      hit = rows.reduce((best, row, key) => {
        const rect = row.getBoundingClientRect();
        const near = Math.abs((rect.top + rect.bottom) / 2 - event.clientY);
        const cur = rows[best].getBoundingClientRect();
        return near < Math.abs((cur.top + cur.bottom) / 2 - event.clientY)
          ? key
          : best;
      }, 0);
    }
    const target = rows[hit];
    if (!target) return null;
    if (started.kind === "section") {
      const sectionId = target.dataset.sectionId;
      if (!sectionId || sectionId === started.id) return null;
      const index = sections.findIndex((section) => section.id === sectionId);
      return index >= 0
        ? { kind: "section", id: started.id, sectionId, order: index }
        : null;
    }
    // Tasks resolve the prospective section and its section-local order.
    const sectionId = target.dataset.sectionId;
    if (!sectionId) return null;
    const order = rows
      .slice(0, hit)
      .filter(
        (row) =>
          row.dataset.sectionId === sectionId &&
          row.dataset.myoxusUiRole === "gantt-row-label",
      ).length;
    return { kind: "task", id: started.id, sectionId, order };
  };
  const finishDrag = (event: PointerEvent) => {
    const draft = dragTarget(event);
    dragRef.current = null;
    setPreview(null);
    try {
      (event.currentTarget as HTMLElement).releasePointerCapture?.(
        event.pointerId,
      );
    } catch {
      /* already released */
    }
    if (draft) commit(draft);
  };
  const handleDraftKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      cancel();
      return true;
    }
    if (event.key === "Enter" && preview) {
      event.preventDefault();
      event.stopPropagation();
      commit(preview);
      return true;
    }
    return false;
  };
  const handleSectionKey = (event: KeyboardEvent, index: number) => {
    if (readonly || handleDraftKey(event)) return;
    if (
      event.altKey &&
      (event.key === "ArrowUp" || event.key === "ArrowDown")
    ) {
      event.preventDefault();
      const id = sections[index]!.id;
      const previous =
        preview?.kind === "section" && preview.id === id
          ? preview.order
          : index;
      setPreview({
        kind: "section",
        id,
        sectionId: id,
        order: Math.max(
          0,
          Math.min(
            sections.length - 1,
            previous + (event.key === "ArrowUp" ? -1 : 1),
          ),
        ),
      });
    }
  };
  const handleTaskKey = (
    event: KeyboardEvent,
    task: GanttListRowView,
    sectionId: string,
    taskIndex: number,
  ) => {
    if (readonly || handleDraftKey(event) || !event.altKey) return;
    const order = preview?.id === task.id ? preview.order : taskIndex;
    const last = rows.filter((row) => row.section.id === sectionId).length - 1;
    const step =
      event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
    if (!step || order + step < 0 || order + step > last) return;
    event.preventDefault();
    setPreview({ kind: "task", id: task.id, sectionId, order: order + step });
  };
  const layout = ganttLayout(
    sections,
    rows.map((row) => row.task),
    rowHeight,
  );
  const previewTarget =
    preview?.kind === "section"
      ? layout.find(
          (entry) =>
            entry.kind === "section" &&
            entry.sectionId === sections[preview.order]?.id,
        )
      : preview
        ? layout.filter(
            (entry) =>
              entry.kind === "task" && entry.sectionId === preview.sectionId,
          )[preview.order]
        : null;
  if (
    intrinsicLabels ||
    metadataColumns.length ||
    rows.some((row) => row.task.notice)
  ) {
    return (
      <Box data-myoxus-ui-role="gantt-labels" ref={rootRef}>
        {previewTarget ? (
          <Box
            data-myoxus-ui-role="gantt-insert-marker"
            style={{
              position: "absolute",
              insetBlockStart: headerHeight + previewTarget.offset,
              blockSize: 3,
              inlineSize: "100%",
              zIndex: 7,
            }}
          />
        ) : null}
        <Table data-myoxus-ui-role="gantt-pinned-table">
          <Table.Thead>
            <Table.Tr style={{ blockSize: headerHeight }}>
              {[{ id: "title", label: labels.row }, ...metadataColumns].map(
                (column) => (
                  // Reserve primary-label space within the measured pinned
                  // track. Native column minima still keep metadata readable;
                  // unconstrained auto layout made long titles six-line cells.
                  <Table.Th
                    key={column.id}
                    w={column.id === "title" ? "50%" : undefined}
                  >
                    <Text
                      size="sm"
                      data-myoxus-ui-role="gantt-intrinsic-header"
                    >
                      {column.label}
                    </Text>
                  </Table.Th>
                ),
              )}
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {sections.map((section, sectionIndex) => (
              <Fragment key={section.id}>
                <Table.Tr
                  data-myoxus-ui-role="gantt-section-header"
                  data-section-id={section.id}
                  aria-expanded={
                    onToggleSection ? !section.collapsed : undefined
                  }
                  role={onToggleSection ? "button" : undefined}
                  tabIndex={0}
                  style={{ blockSize: GANTT_SECTION_HEADER_HEIGHT }}
                  onPointerDown={() =>
                    onToggleSection
                      ? onToggleSection(section.id, !section.collapsed)
                      : onSelectSection?.(section.id)
                  }
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      if (onToggleSection)
                        onToggleSection(section.id, !section.collapsed);
                      else onSelectSection?.(section.id);
                    }
                  }}
                >
                  <Table.Td colSpan={metadataColumns.length + 1}>
                    <Group wrap="nowrap">
                      {!readonly && reorder?.sections.enabled !== false ? (
                        <ActionIcon
                          aria-label={labels.reorderSection}
                          data-testid={`gantt-section-reorder-${section.id}`}
                          onKeyDown={(event) =>
                            handleSectionKey(event, sectionIndex)
                          }
                          onPointerDown={(event) =>
                            beginDrag(event, {
                              id: section.id,
                              kind: "section",
                              sectionId: section.id,
                            })
                          }
                          onPointerUp={finishDrag}
                          onPointerMove={(event) => {
                            if (dragRef.current) setPreview(dragTarget(event));
                          }}
                          onPointerCancel={cancel}
                          onLostPointerCapture={cancel}
                          variant="subtle"
                        >
                          <GripVerticalIcon />
                        </ActionIcon>
                      ) : null}
                      {onToggleSection ? (
                        section.collapsed ? (
                          <ChevronRightIcon />
                        ) : (
                          <ChevronDownIcon />
                        )
                      ) : null}
                      <Text size="sm">{section.label}</Text>
                      {section.count !== undefined ? (
                        <Text size="sm">{section.count}</Text>
                      ) : null}
                    </Group>
                  </Table.Td>
                </Table.Tr>
                {rows
                  .filter((row) => row.section.id === section.id)
                  .map((row, taskIndex) => (
                    <Table.Tr
                      key={row.task.id}
                      data-myoxus-ui-role="gantt-row-label"
                      data-section-id={section.id}
                      data-selected={
                        row.task.selected ?? row.task.id === selectedTaskId
                      }
                      style={{ blockSize: rowHeight }}
                    >
                      <Table.Td>
                        <Box data-myoxus-ui-role="gantt-intrinsic-cell">
                          <Group>
                            {row.task.labelContent ?? (
                              <Text
                                size="sm"
                                data-testid={`gantt-label-${row.task.id}`}
                                role={onOpenTask ? "button" : undefined}
                                tabIndex={onOpenTask ? 0 : undefined}
                                onKeyDown={(event) => {
                                  if (
                                    !readonly &&
                                    onDeleteTask &&
                                    (event.key === "Delete" ||
                                      event.key === "Backspace")
                                  ) {
                                    event.preventDefault();
                                    event.stopPropagation();
                                    onDeleteTask(row.task.id);
                                  } else if (event.key === " ") {
                                    event.preventDefault();
                                    onSelectTask?.(row.task.id);
                                  } else if (event.key === "Enter") {
                                    event.preventDefault();
                                    onOpenTask?.(row.task.id);
                                  } else if (event.key === "F2" && !readonly) {
                                    event.preventDefault();
                                    onRenameTask?.(row.task.id);
                                  }
                                }}
                                onClick={() => onSelectTask?.(row.task.id)}
                                onDoubleClick={() =>
                                  !readonly && onRenameTask?.(row.task.id)
                                }
                              >
                                {row.task.label}
                              </Text>
                            )}
                            {row.task.labelAccessory}
                            {connectionEndpoint(row.task)}
                            {!readonly && reorder?.tasks.enabled !== false && (
                              <Tooltip label={labels.reorderTask}>
                                <ActionIcon
                                  aria-label={labels.reorderTask}
                                  data-testid={`gantt-task-reorder-${row.task.id}`}
                                  onPointerDown={(event) =>
                                    beginDrag(event, {
                                      id: row.task.id,
                                      kind: "task",
                                      sectionId: section.id,
                                    })
                                  }
                                  onPointerUp={finishDrag}
                                  onPointerMove={(event) => {
                                    if (dragRef.current)
                                      setPreview(dragTarget(event));
                                  }}
                                  onPointerCancel={cancel}
                                  onLostPointerCapture={cancel}
                                  onKeyDown={(event) => {
                                    if (readonly || handleDraftKey(event))
                                      return;
                                    if (
                                      event.altKey &&
                                      event.key === "ArrowUp" &&
                                      (preview?.id === row.task.id
                                        ? preview.order
                                        : taskIndex) > 0
                                    ) {
                                      event.preventDefault();
                                      setPreview({
                                        kind: "task",
                                        id: row.task.id,
                                        sectionId: section.id,
                                        order:
                                          (preview?.id === row.task.id
                                            ? preview.order
                                            : taskIndex) - 1,
                                      });
                                    }
                                    if (
                                      event.altKey &&
                                      event.key === "ArrowDown" &&
                                      (preview?.id === row.task.id
                                        ? preview.order
                                        : taskIndex) <
                                        rows.filter(
                                          (entry) =>
                                            entry.section.id === section.id,
                                        ).length -
                                          1
                                    ) {
                                      event.preventDefault();
                                      setPreview({
                                        kind: "task",
                                        id: row.task.id,
                                        sectionId: section.id,
                                        order:
                                          (preview?.id === row.task.id
                                            ? preview.order
                                            : taskIndex) + 1,
                                      });
                                    }
                                  }}
                                  size="xs"
                                  variant="subtle"
                                >
                                  <GripVerticalIcon size={12} />
                                </ActionIcon>
                              </Tooltip>
                            )}
                          </Group>
                          {row.task.notice}
                          {!readonly &&
                            (row.task.statuses ?? []).length > 0 && (
                              <Text c="dimmed" size="xs">
                                {(row.task.statuses ?? []).join(", ")}
                              </Text>
                            )}
                        </Box>
                      </Table.Td>
                      {metadataColumns.map((column) => (
                        <Table.Td key={column.id}>
                          <Box data-myoxus-ui-role="gantt-intrinsic-cell">
                            {row.task.metadata?.[column.id]}
                          </Box>
                        </Table.Td>
                      ))}
                    </Table.Tr>
                  ))}
              </Fragment>
            ))}
          </Table.Tbody>
        </Table>
      </Box>
    );
  }
  return (
    <Box data-myoxus-ui-role="gantt-labels" ref={rootRef}>
      {previewTarget ? (
        <Box
          data-myoxus-ui-role="gantt-insert-marker"
          style={{
            position: "absolute",
            insetBlockStart: headerHeight + previewTarget.offset,
            blockSize: 3,
            inlineSize: "100%",
            zIndex: 7,
          }}
        />
      ) : null}
      {/* Spacer matching the time surface axis header so both columns share rows. */}
      <Box
        data-myoxus-ui-role="gantt-label-spacer"
        style={{ blockSize: headerHeight }}
      ></Box>
      {sections.map((section, sectionIndex) => {
        const sectionRows = rows.filter((row) => row.section.id === section.id);
        return (
          <Box key={section.id}>
            <Box
              data-myoxus-ui-role="gantt-section-header"
              data-section-id={section.id}
              data-selected={section.id === selectedSectionId}
              aria-expanded={onToggleSection ? !section.collapsed : undefined}
              role={onToggleSection ? "button" : undefined}
              onPointerDown={() =>
                onToggleSection
                  ? onToggleSection(section.id, !section.collapsed)
                  : onSelectSection?.(section.id)
              }
              style={{ blockSize: GANTT_SECTION_HEADER_HEIGHT }}
              tabIndex={0}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  if (onToggleSection)
                    onToggleSection(section.id, !section.collapsed);
                  else onSelectSection?.(section.id);
                }
              }}
            >
              {!readonly && reorder?.sections.enabled !== false && (
                <Tooltip label={labels.reorderSection}>
                  <ActionIcon
                    aria-label={labels.reorderSection}
                    data-testid={`gantt-section-reorder-${section.id}`}
                    onKeyDown={(event) => handleSectionKey(event, sectionIndex)}
                    onPointerDown={(event) =>
                      beginDrag(event, {
                        id: section.id,
                        kind: "section",
                        sectionId: section.id,
                      })
                    }
                    onPointerUp={finishDrag}
                    onPointerMove={(event) => {
                      if (dragRef.current) setPreview(dragTarget(event));
                    }}
                    onPointerCancel={cancel}
                    onLostPointerCapture={cancel}
                    size="xs"
                    variant="subtle"
                  >
                    <GripVerticalIcon size={14} />
                  </ActionIcon>
                </Tooltip>
              )}
              {onToggleSection ? (
                section.collapsed ? (
                  <ChevronRightIcon />
                ) : (
                  <ChevronDownIcon />
                )
              ) : null}
              <Text size="sm" truncate>
                {section.label}
              </Text>
              {section.count !== undefined ? (
                <Text size="sm">{section.count}</Text>
              ) : null}
            </Box>
            {sectionRows.map((row, taskIndex) => (
              <Box
                data-myoxus-ui-role="gantt-row-label"
                data-section-id={section.id}
                data-selected={
                  row.task.selected ?? row.task.id === selectedTaskId
                }
                key={row.task.id}
                style={{ blockSize: rowHeight }}
              >
                <>
                  {" "}
                  {row.task.labelContent ?? (
                    <Text
                      size="sm"
                      data-testid={`gantt-label-${row.task.id}`}
                      role={onOpenTask ? "button" : undefined}
                      tabIndex={onOpenTask ? 0 : undefined}
                      onKeyDown={(event) => {
                        if (
                          !readonly &&
                          onDeleteTask &&
                          (event.key === "Delete" || event.key === "Backspace")
                        ) {
                          event.preventDefault();
                          event.stopPropagation();
                          onDeleteTask(row.task.id);
                        } else if (event.key === " ") {
                          event.preventDefault();
                          onSelectTask?.(row.task.id);
                        } else if (event.key === "Enter") {
                          event.preventDefault();
                          onOpenTask?.(row.task.id);
                        } else if (event.key === "F2" && !readonly) {
                          event.preventDefault();
                          onRenameTask?.(row.task.id);
                        }
                      }}
                      truncate={!metadataColumns.length}
                      onClick={() => onSelectTask?.(row.task.id)}
                      onDoubleClick={() =>
                        !readonly && onRenameTask?.(row.task.id)
                      }
                    >
                      {row.task.label}
                    </Text>
                  )}
                  {row.task.labelAccessory}
                  {connectionEndpoint(row.task)}
                  {row.task.notice}
                </>
                {!readonly && (row.task.statuses ?? []).length > 0 && (
                  <Text c="dimmed" size="xs">
                    {(row.task.statuses ?? []).join(", ")}
                  </Text>
                )}
                {!readonly && reorder?.tasks.enabled !== false && (
                  <Tooltip label={labels.reorderTask}>
                    <ActionIcon
                      aria-label={labels.reorderTask}
                      data-testid={`gantt-task-reorder-${row.task.id}`}
                      onPointerDown={(event) =>
                        beginDrag(event, {
                          id: row.task.id,
                          kind: "task",
                          sectionId: section.id,
                        })
                      }
                      onPointerUp={finishDrag}
                      onPointerMove={(event) => {
                        if (dragRef.current) setPreview(dragTarget(event));
                      }}
                      onPointerCancel={cancel}
                      onLostPointerCapture={cancel}
                      onKeyDown={(event) =>
                        handleTaskKey(event, row.task, section.id, taskIndex)
                      }
                      size="xs"
                      variant="subtle"
                    >
                      <GripVerticalIcon size={12} />
                    </ActionIcon>
                  </Tooltip>
                )}
              </Box>
            ))}
          </Box>
        );
      })}
    </Box>
  );
}
