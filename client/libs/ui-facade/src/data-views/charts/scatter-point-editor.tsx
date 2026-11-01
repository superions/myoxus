// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  Button,
  Group,
  NumberInput,
  Stack,
  Table,
  Text,
  TextInput,
} from "@mantine/core";
import { useEffect, useId, useState } from "react";

import { type DNDData, useDraggable, useDropTarget } from "../../dnd";
import { DragHandle } from "../../drag-handle";

export type DataScatterPointEditorItem = {
  readonly id: string;
  readonly issue?: string;
  readonly label: string;
  readonly x: number;
  readonly y: number;
};

export type DataScatterPointEditorProps = {
  readonly addLabel?: string;
  readonly deleteLabel?: string;
  readonly invalidLabel?: string;
  readonly items: ReadonlyArray<DataScatterPointEditorItem>;
  readonly label: string;
  readonly labelColumn: string;
  readonly onAdd?: () => void;
  readonly onDelete?: (id: string) => void;
  readonly onLabelChange: (id: string, label: string) => boolean | void;
  readonly onPositionChange: (
    id: string,
    x: number,
    y: number,
  ) => boolean | void;
  readonly onReorder: (id: string, beforeId?: string) => void;
  readonly onSelect: (id: string) => void;
  readonly readonly: boolean;
  readonly reorderLabel: string;
  readonly selectedId?: string;
  readonly xColumn: string;
  readonly yColumn: string;
};

type ScatterEditorDnd = DNDData<
  { itemId: string; listId: string; type: "scatter-editor-item" },
  { itemId: string; listId: string; type: "scatter-editor-target" }
>;

function DataScatterPointEditorRow({
  item,
  items,
  listId,
  props,
}: {
  readonly item: DataScatterPointEditorItem;
  readonly items: ReadonlyArray<DataScatterPointEditorItem>;
  readonly listId: string;
  readonly props: DataScatterPointEditorProps;
}) {
  const [label, setLabel] = useState(item.label);
  const [x, setX] = useState<number | string>(item.x);
  const [y, setY] = useState<number | string>(item.y);
  const [invalid, setInvalid] = useState(false);
  useEffect(() => {
    setLabel(item.label);
    setX(item.x);
    setY(item.y);
    setInvalid(false);
  }, [item.label, item.x, item.y]);
  const applyLabel = () => {
    const next = label.trim();
    const accepted =
      Boolean(next) &&
      (next === item.label || props.onLabelChange(item.id, next) !== false);
    setInvalid(!accepted);
  };
  const applyPosition = () => {
    const accepted =
      typeof x === "number" &&
      Number.isFinite(x) &&
      x >= 0 &&
      x <= 1 &&
      typeof y === "number" &&
      Number.isFinite(y) &&
      y >= 0 &&
      y <= 1 &&
      ((x === item.x && y === item.y) ||
        props.onPositionChange(item.id, x, y) !== false);
    setInvalid(!accepted);
  };
  const { dragHandleRef, dragRef, dragging } = useDraggable<ScatterEditorDnd>(
    () => ({
      canDrag: !props.readonly,
      data: { itemId: item.id, listId, type: "scatter-editor-item" },
    }),
    [item.id, listId, props.readonly],
  );
  const { closestEdge, dropTargetRef } = useDropTarget<ScatterEditorDnd>(
    () => ({
      canDrop: ({ source }) =>
        !props.readonly &&
        source.data.type === "scatter-editor-item" &&
        source.data.listId === listId &&
        source.data.itemId !== item.id,
      closestEdge: { allowedEdges: ["top", "bottom"] },
      data: { itemId: item.id, listId, type: "scatter-editor-target" },
      onDrop: ({ closestEdge: edge, source }) => {
        if (source.data.type !== "scatter-editor-item") return;
        const index = items.indexOf(item);
        props.onReorder(
          source.data.itemId,
          edge === "top" ? item.id : items[index + 1]?.id,
        );
      },
    }),
    [item, items, listId, props],
  );
  const keyboardReorder = (delta: -1 | 1) => {
    const index = items.indexOf(item);
    const target = index + delta;
    if (target < 0 || target >= items.length) return;
    props.onReorder(
      item.id,
      delta < 0 ? items[target].id : items[target + 1]?.id,
    );
  };
  return (
    <Table.Tr
      ref={(element) => {
        dragRef.current = element;
        dropTargetRef.current = element;
      }}
      className="myoxus-data-chart-editor-row"
      data-dragging={dragging || undefined}
      data-drop-edge={closestEdge ?? undefined}
      data-selected={props.selectedId === item.id || undefined}
      onClick={() => props.onSelect(item.id)}
    >
      <Table.Td>
        <Stack gap="xs">
          <TextInput
            aria-label={`${props.labelColumn}: ${item.label}`}
            disabled={props.readonly}
            error={invalid ? props.invalidLabel : undefined}
            onBlur={applyLabel}
            onChange={(event) => setLabel(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") applyLabel();
              else if (event.key === "Escape") setLabel(item.label);
            }}
            value={label}
          />
          {item.issue ? (
            <Text c="myoxusError" role="status" size="xs">
              {item.issue}
            </Text>
          ) : null}
        </Stack>
      </Table.Td>
      {(
        [
          [props.xColumn, x, setX],
          [props.yColumn, y, setY],
        ] as const
      ).map(([column, value, setValue]) => (
        <Table.Td key={column}>
          <NumberInput
            aria-label={`${column}: ${item.label}`}
            decimalScale={4}
            disabled={props.readonly}
            max={1}
            min={0}
            onBlur={applyPosition}
            onChange={setValue}
            onKeyDown={(event) => {
              if (event.key === "Enter") applyPosition();
              else if (event.key === "Escape") {
                setX(item.x);
                setY(item.y);
              }
            }}
            step={0.01}
            value={value}
          />
        </Table.Td>
      ))}
      <Table.Td>
        <Group justify="flex-end" wrap="nowrap">
          <DragHandle
            ref={dragHandleRef}
            aria-label={props.reorderLabel}
            disabled={props.readonly}
            dragging={dragging}
            keyboardMoveModifier="alt"
            keyboardMoveOrientation="vertical"
            onKeyboardMove={keyboardReorder}
          />
          {props.onDelete && props.deleteLabel ? (
            <Button
              disabled={props.readonly}
              onClick={(event) => {
                event.stopPropagation();
                props.onDelete?.(item.id);
              }}
              variant="subtle"
            >
              {props.deleteLabel}
            </Button>
          ) : null}
        </Group>
      </Table.Td>
    </Table.Tr>
  );
}

export function DataScatterPointEditor(props: DataScatterPointEditorProps) {
  const listId = useId();
  return (
    <Stack aria-label={props.label} gap="sm" role="region">
      <Table.ScrollContainer minWidth={500}>
        <Table highlightOnHover>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>{props.labelColumn}</Table.Th>
              <Table.Th>{props.xColumn}</Table.Th>
              <Table.Th>{props.yColumn}</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {props.items.map((item) => (
              <DataScatterPointEditorRow
                item={item}
                items={props.items}
                key={item.id}
                listId={listId}
                props={props}
              />
            ))}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
      {props.onAdd && props.addLabel ? (
        <Button
          disabled={props.readonly}
          onClick={props.onAdd}
          variant="subtle"
        >
          {props.addLabel}
        </Button>
      ) : null}
    </Stack>
  );
}
