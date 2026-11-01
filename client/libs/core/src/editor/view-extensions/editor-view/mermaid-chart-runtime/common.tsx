// SPDX-License-Identifier: AGPL-3.0-or-later

import { Button, Group } from "@myoxus/ui-facade";
import type { MermaidPageViewportProjection } from "@virgultum/block-mermaid";
import { type ReactNode, type SyntheticEvent, useEffect, useRef } from "react";

import {
  MermaidEditorWorkbench,
  useMermaidSelectionAction,
} from "../mermaid-editor-workbench";
import { MermaidEmbeddedActions } from "../mermaid-embedded-actions";

export const CHART_COLORS = [
  "var(--myoxus-primary-color)",
  "var(--myoxus-processing-color)",
  "var(--myoxus-success-color)",
  "var(--myoxus-warning-color)",
  "var(--myoxus-error-color)",
] as const;

export function stopEditorEvent(event: SyntheticEvent) {
  event.stopPropagation();
}

export function Actions({
  deleteLabel,
  disabled,
  downLabel,
  onDelete,
  onDown,
  onUp,
  upLabel,
}: {
  readonly deleteLabel?: string;
  readonly disabled: boolean;
  readonly downLabel: string;
  readonly onDelete?: () => void;
  readonly onDown: () => void;
  readonly onUp: () => void;
  readonly upLabel: string;
}) {
  return (
    <Group wrap="nowrap">
      <Button disabled={disabled} onClick={onUp} variant="plain">
        {upLabel}
      </Button>
      <Button disabled={disabled} onClick={onDown} variant="plain">
        {downLabel}
      </Button>
      {onDelete ? (
        <Button disabled={disabled} onClick={onDelete} variant="plain">
          {deleteLabel}
        </Button>
      ) : null}
    </Group>
  );
}

export function ChartEditorSurface({
  actionTarget,
  children,
  context,
  contextTitle,
  embedded = false,
  contextOpened,
  onCloseContext,
  pageViewport,
  selectedId,
  selectionAction,
  toolbar,
  workareaLabel,
}: {
  readonly actionTarget?: HTMLElement | null;
  readonly children: ReactNode;
  readonly context: ReactNode;
  readonly contextTitle: ReactNode;
  readonly embedded?: boolean;
  readonly contextOpened?: boolean;
  readonly onCloseContext: () => void;
  readonly pageViewport?: MermaidPageViewportProjection;
  readonly selectedId?: string;
  readonly selectionAction: {
    readonly disabled: boolean;
    readonly label: string;
    readonly onSelect: () => void;
    readonly register: Parameters<
      typeof useMermaidSelectionAction
    >[0]["register"];
    readonly selectionKey?: string;
  };
  readonly toolbar: ReactNode;
  readonly workareaLabel: string;
}) {
  const workareaRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  useMermaidSelectionAction({
    ...selectionAction,
    selectionKey: selectionAction.selectionKey ?? selectedId,
  });

  useEffect(() => {
    if (!selectedId) return;
    returnFocusRef.current =
      Array.from(
        workareaRef.current?.querySelectorAll<HTMLElement>(
          "[data-chart-axis-id], [data-chart-category-id], [data-chart-comment-id], [data-chart-curve-id], [data-chart-item-id], [data-chart-link-id], [data-chart-node-id], [data-chart-point-id], [data-chart-plot-id]",
        ) ?? [],
      ).find(
        (element) =>
          element.dataset.chartItemId === selectedId ||
          element.dataset.chartCommentId === selectedId ||
          element.dataset.chartLinkId === selectedId ||
          element.dataset.chartNodeId === selectedId ||
          element.dataset.chartAxisId === selectedId ||
          element.dataset.chartCurveId === selectedId ||
          element.dataset.chartPointId === selectedId ||
          element.dataset.chartPlotId === selectedId ||
          element.dataset.chartCategoryId === selectedId,
      ) ?? null;
  }, [selectedId]);

  return (
    <MermaidEditorWorkbench
      actionTarget={actionTarget}
      context={context}
      contextCompact={embedded}
      contextOpened={contextOpened ?? Boolean(selectedId)}
      contextTitle={contextTitle}
      isolateEvents={!embedded}
      onContextOpenChange={(opened) => {
        if (!opened) onCloseContext();
      }}
      pageViewport={embedded ? undefined : pageViewport}
      returnFocusRef={returnFocusRef}
      toolbar={embedded ? null : toolbar}
      workareaLabel={workareaLabel}
    >
      {embedded && toolbar ? (
        <MermaidEmbeddedActions
          actions={toolbar}
          label={workareaLabel}
          placement="inline"
        />
      ) : null}
      <div ref={workareaRef}>{children}</div>
    </MermaidEditorWorkbench>
  );
}
