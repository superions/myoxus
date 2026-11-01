// SPDX-License-Identifier: AGPL-3.0-or-later

import { PlusIcon } from "@myoxus/icons";
import { Button, DataPieChart, type DataPieChartItem } from "@myoxus/ui-facade";
import type {
  MermaidPieAppearanceDraft,
  MermaidPieReactHostProps,
} from "@virgultum/block-mermaid";
import { MermaidPieComments } from "./comments";
import { MermaidPieSlicePopover } from "./slice-popover";

export function MermaidPieChartSurface({
  appearance,
  commentsVisible,
  draft,
  draftDiagnosis,
  draftValid,
  focusRequestKey,
  focusSelectedId,
  onAdd,
  onDraftApply,
  onDraftChange,
  onDraftInvalidated,
  onReorder,
  onRename,
  onSelect,
  onSelectionClose,
  onValueApply,
  props,
  selectionEditorOpen,
  selectedId,
}: {
  readonly appearance: MermaidPieAppearanceDraft | null;
  readonly commentsVisible: boolean;
  readonly draft: DataPieChartItem | null;
  readonly draftDiagnosis: string | null;
  readonly draftValid: boolean;
  readonly focusRequestKey: number;
  readonly focusSelectedId?: string;
  readonly onAdd: () => void;
  readonly onDraftApply: () => void;
  readonly onDraftChange: (label: string, value: number) => void;
  readonly onDraftInvalidated: () => void;
  readonly onReorder: (sliceId: string, beforeSliceId?: string) => void;
  readonly onRename: (sliceId: string, label: string) => boolean;
  readonly onSelect: (sliceId: string) => void;
  readonly onSelectionClose: () => void;
  readonly onValueApply: (sliceId: string, value: number) => void;
  readonly props: MermaidPieReactHostProps;
  readonly selectionEditorOpen: boolean;
  readonly selectedId?: string;
}) {
  const highlightSlice =
    appearance?.options.highlightSlice ?? props.model.options.highlightSlice;
  return (
    <DataPieChart
      ariaLabel={props.labels.chart}
      data={props.items}
      diagramMarker={
        commentsVisible ? (
          <MermaidPieComments
            comments={props.diagramComments}
            onDraftInvalidated={onDraftInvalidated}
            props={props}
          />
        ) : undefined
      }
      donut={appearance?.options.donutHole ?? props.model.options.donutHole}
      draftItem={draft ?? undefined}
      emptyAction={
        props.readonly ? undefined : (
          <Button prefix={<PlusIcon />} onClick={onAdd}>
            {props.labels.add}
          </Button>
        )
      }
      emptyLabel={props.labels.empty}
      focusRequestKey={focusRequestKey}
      highlightedId={
        highlightSlice === "hover"
          ? "hover"
          : props.sliceIdForLabel(highlightSlice)
      }
      invalidLabel={props.labels.invalid}
      labelMode={
        (appearance?.showData ?? props.model.showData) ? "value" : "name"
      }
      labelPosition={
        appearance?.options.textPosition ?? props.model.options.textPosition
      }
      legendMarker={
        commentsVisible
          ? (item) =>
              item.id === draft?.id ? null : (
                <MermaidPieComments
                  comments={props.commentsForSlice(item.id)}
                  onDraftInvalidated={onDraftInvalidated}
                  props={props}
                  sliceId={item.id}
                />
              )
          : undefined
      }
      legendPosition={
        appearance?.options.legendPosition ?? props.model.options.legendPosition
      }
      focusSelectedId={focusSelectedId}
      onLegendReorder={props.readonly ? undefined : onReorder}
      onLegendRename={props.readonly ? undefined : onRename}
      onLegendSelect={props.readonly ? undefined : onSelect}
      onSelectionEditorClose={onSelectionClose}
      onDraftInvalidated={onDraftInvalidated}
      revision={props.model.sourceHash}
      onSegmentSelect={props.readonly ? undefined : onSelect}
      reorderLabel={props.labels.down}
      selectedId={selectedId}
      selectionEditor={
        selectionEditorOpen
          ? (item, { close }) => (
              <MermaidPieSlicePopover
                close={close}
                draft={item.id === draft?.id}
                draftDiagnosis={draftDiagnosis}
                draftValid={draftValid}
                item={item}
                onDraftApply={onDraftApply}
                onDraftChange={onDraftChange}
                onValueApply={onValueApply}
                props={props}
              />
            )
          : undefined
      }
      zeroStateLabel={props.labels.zeroValues}
    />
  );
}
