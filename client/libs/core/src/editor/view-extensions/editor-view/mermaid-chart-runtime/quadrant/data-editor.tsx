// SPDX-License-Identifier: AGPL-3.0-or-later

import { DataScatterPointEditor } from "@myoxus/ui-facade";
import type { MermaidQuadrantReactHostProps } from "@virgultum/block-mermaid";

export function MermaidQuadrantDataEditor({
  onAdd,
  onDelete,
  onMove,
  onRename,
  onReorder,
  onSelect,
  props,
  selectedId,
}: {
  readonly onAdd: () => void;
  readonly onDelete: (id: string) => void;
  readonly onMove: (id: string, x: number, y: number) => boolean;
  readonly onRename: (id: string, label: string) => boolean;
  readonly onReorder: (id: string, beforeId?: string) => void;
  readonly onSelect: (id: string) => void;
  readonly props: MermaidQuadrantReactHostProps;
  readonly selectedId?: string;
}) {
  return (
    <DataScatterPointEditor
      addLabel={props.labels.add}
      deleteLabel={props.labels.delete}
      invalidLabel={props.labels.invalid}
      items={props.model.points.map((point) => ({
        id: point.id,
        issue: props.model.diagnostics.find(
          (diagnostic) => diagnostic.recordId === point.sourceRecordId,
        )?.message,
        label: point.label,
        x: point.x,
        y: point.y,
      }))}
      label={props.labels.data}
      labelColumn={props.labels.label}
      onAdd={onAdd}
      onDelete={onDelete}
      onLabelChange={onRename}
      onPositionChange={onMove}
      onReorder={onReorder}
      onSelect={onSelect}
      readonly={props.readonly}
      reorderLabel={props.labels.down}
      selectedId={selectedId}
      xColumn={props.labels.x}
      yColumn={props.labels.y}
    />
  );
}
