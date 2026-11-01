// SPDX-License-Identifier: AGPL-3.0-or-later

import { DataChartValueEditor } from "@myoxus/ui-facade";
import type { MermaidPieReactHostProps } from "@virgultum/block-mermaid";

export function MermaidPieDataEditor({
  onAdd,
  onDelete,
  onLabelChange,
  onReorder,
  onSelect,
  onValueChange,
  props,
  selectedId,
}: {
  readonly onAdd: () => void;
  readonly onDelete: (sliceId: string) => void;
  readonly onLabelChange: (sliceId: string, label: string) => boolean;
  readonly onReorder: (sliceId: string, beforeSliceId?: string) => void;
  readonly onSelect: (sliceId: string) => void;
  readonly onValueChange: (sliceId: string, value: number) => boolean;
  readonly props: MermaidPieReactHostProps;
  readonly selectedId?: string;
}) {
  return (
    <DataChartValueEditor
      addLabel={props.labels.add}
      deleteLabel={props.labels.delete}
      items={props.items}
      invalidLabel={props.labels.invalid}
      label={props.labels.data}
      labelColumn={props.labels.label}
      onAdd={onAdd}
      onDelete={onDelete}
      onLabelChange={onLabelChange}
      onReorder={onReorder}
      onSelect={onSelect}
      onValueChange={onValueChange}
      readonly={props.readonly}
      reorderLabel={props.labels.down}
      selectedId={selectedId}
      valueColumn={props.labels.value}
    />
  );
}
