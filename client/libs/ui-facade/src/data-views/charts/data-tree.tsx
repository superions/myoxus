// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  Box,
  Grid,
  Group,
  Stack,
  getTreeExpandedState,
  Text,
  Tree as MantineTree,
  useTree,
} from "@mantine/core";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";

import { type DNDData, useDraggable, useDropTarget } from "../../dnd";
import { DragHandle } from "../../drag-handle";

export type DataTreeNode = {
  readonly actions?: ReactNode;
  readonly cells?: readonly ReactNode[];
  readonly children?: readonly DataTreeNode[];
  readonly id: string;
  readonly label: ReactNode;
  readonly parentId?: string | null;
  readonly sourceOrder?: number;
};

export type DataTreeProps = {
  readonly ariaLabel: string;
  readonly columns?: readonly {
    readonly label: ReactNode;
    readonly span: number;
  }[];
  readonly data: readonly DataTreeNode[];
  readonly onSelect?: (id: string) => void;
  readonly onReorder?: (
    id: string,
    siblingId: string,
    position: "before" | "after",
  ) => void;
  readonly readonly?: boolean;
  readonly reorderLabel?: string;
  readonly selectedId?: string;
};

type DataTreeDnd = DNDData<
  {
    readonly id: string;
    readonly parentId: string | null;
    readonly type: "data-tree-item";
  },
  {
    readonly id: string;
    readonly parentId: string | null;
    readonly type: "data-tree-target";
  }
>;

function DataTreeRow({
  columns,
  elementProps,
  id,
  label,
  level,
  nodes,
  onReorder,
  parentId,
  readonly,
  reorderLabel,
  selected,
}: {
  readonly columns?: DataTreeProps["columns"];
  readonly elementProps: Record<string, unknown>;
  readonly id: string;
  readonly label: ReactNode;
  readonly level: number;
  readonly nodes: readonly DataTreeNode[];
  readonly onReorder?: DataTreeProps["onReorder"];
  readonly parentId: string | null;
  readonly readonly: boolean;
  readonly reorderLabel: string;
  readonly selected: boolean;
}) {
  const { dragHandleRef, dragRef, dragging } = useDraggable<DataTreeDnd>(
    () => ({
      canDrag: !readonly && Boolean(onReorder),
      data: { id, parentId, type: "data-tree-item" },
    }),
    [id, onReorder, parentId, readonly],
  );
  const { closestEdge, dropTargetRef } = useDropTarget<DataTreeDnd>(
    () => ({
      canDrop: ({ source }) =>
        !readonly &&
        source.data.type === "data-tree-item" &&
        source.data.parentId === parentId &&
        source.data.id !== id,
      closestEdge: { allowedEdges: ["top", "bottom"] },
      data: { id, parentId, type: "data-tree-target" },
      onDrop: ({ closestEdge: edge, source }) => {
        if (source.data.type !== "data-tree-item") return;
        onReorder?.(source.data.id, id, edge === "top" ? "before" : "after");
      },
    }),
    [id, onReorder, parentId, readonly],
  );
  const setRowRef = (element: HTMLDivElement | null) => {
    dragRef.current = element;
    dropTargetRef.current = element;
  };
  const siblings = nodes
    .filter((node) => (node.parentId ?? null) === parentId)
    .sort((left, right) => (left.sourceOrder ?? 0) - (right.sourceOrder ?? 0));
  const item = nodes.find((node) => node.id === id);
  return (
    <Group
      {...elementProps}
      ref={setRowRef}
      data-chart-item-id={id}
      data-dragging={dragging || undefined}
      data-drop-edge={closestEdge ?? undefined}
      data-selected={selected || undefined}
      justify="space-between"
      wrap="nowrap"
    >
      {columns?.length ? (
        <Grid columns={12} gap="xs" w="100%" align="center">
          <Grid.Col span={columns[0]?.span ?? 6}>
            <Box
              ps={`calc(${Math.max(0, level - 1)} * var(--mantine-spacing-sm))`}
            >
              <Text component="div" truncate>
                {label}
              </Text>
            </Box>
          </Grid.Col>
          {item?.cells?.map((cell, index) => (
            <Grid.Col key={index} span={columns[index + 1]?.span ?? 2}>
              <Text component="div" truncate>
                {cell}
              </Text>
            </Grid.Col>
          ))}
          {item?.actions || onReorder ? (
            <Grid.Col span={columns.at(-1)?.span ?? 1}>
              <Group gap="xs" justify="flex-end" wrap="nowrap">
                {item?.actions}
                {onReorder ? (
                  <DragHandle
                    ref={dragHandleRef}
                    aria-label={reorderLabel}
                    disabled={readonly}
                    dragging={dragging}
                    keyboardMoveModifier="alt"
                    keyboardMoveOrientation="vertical"
                    onClick={(event) => event.stopPropagation()}
                    onKeyDown={(event) => event.stopPropagation()}
                    onKeyboardMove={(offset) => {
                      const index = siblings.findIndex(
                        (node) => node.id === id,
                      );
                      const target = siblings[index + offset];
                      if (target)
                        onReorder(
                          id,
                          target.id,
                          offset < 0 ? "before" : "after",
                        );
                    }}
                  />
                ) : null}
              </Group>
            </Grid.Col>
          ) : null}
        </Grid>
      ) : (
        <Text component="div" truncate>
          {label}
        </Text>
      )}
      {!columns?.length && onReorder ? (
        <DragHandle
          ref={dragHandleRef}
          aria-label={reorderLabel}
          disabled={readonly}
          dragging={dragging}
          keyboardMoveModifier="alt"
          keyboardMoveOrientation="vertical"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          onKeyboardMove={(offset) => {
            const index = siblings.findIndex((node) => node.id === id);
            const target = siblings[index + offset];
            if (target)
              onReorder(id, target.id, offset < 0 ? "before" : "after");
          }}
        />
      ) : null}
    </Group>
  );
}

export function DataTree({
  ariaLabel,
  columns,
  data,
  onReorder,
  onSelect,
  readonly = false,
  reorderLabel = "Reorder",
  selectedId,
}: DataTreeProps) {
  type TreeNode = { children?: TreeNode[]; label: ReactNode; value: string };
  const treeData = useMemo(() => {
    const convert = (node: DataTreeNode): TreeNode => ({
      children: node.children?.map(convert),
      label: node.label,
      value: node.id,
    });
    return data.map(convert);
  }, [data]);
  const flatData = useMemo(() => {
    const flatten = (nodes: readonly DataTreeNode[]): DataTreeNode[] =>
      nodes.flatMap((node) => [node, ...flatten(node.children ?? [])]);
    return flatten(data);
  }, [data]);
  const selectedState = useMemo(
    () => (selectedId ? [selectedId] : []),
    [selectedId],
  );
  const [expandedState, setExpandedState] = useState(() =>
    getTreeExpandedState(treeData, "*"),
  );
  useEffect(() => {
    setExpandedState((current) => {
      const available = getTreeExpandedState(treeData, "*");
      return Object.fromEntries(
        Object.keys(available).map((value) => [value, current[value] ?? true]),
      );
    });
  }, [treeData]);
  const tree = useTree({
    expandedState,
    onExpandedStateChange: setExpandedState,
    onSelectedStateChange: (state) => {
      const next = state.at(-1);
      if (next) onSelect?.(next);
    },
    selectedState,
  });
  return (
    <Stack gap="xs">
      {columns?.length ? (
        <Grid columns={12} gap="xs" w="100%">
          {columns.map((column, index) => (
            <Grid.Col key={index} span={column.span}>
              <Text fw={500} size="sm" truncate>
                {column.label}
              </Text>
            </Grid.Col>
          ))}
        </Grid>
      ) : null}
      <MantineTree
        aria-label={ariaLabel}
        data={treeData}
        data-myoxus-ui-role="data-tree"
        levelOffset={0}
        renderNode={({ elementProps, level, node }) => {
          const item = flatData.find(
            (candidate) => candidate.id === node.value,
          );
          return (
            <DataTreeRow
              columns={columns}
              elementProps={elementProps}
              id={node.value}
              label={node.label}
              level={level}
              nodes={flatData}
              onReorder={onReorder}
              parentId={item?.parentId ?? null}
              readonly={readonly}
              reorderLabel={reorderLabel}
              selected={node.value === selectedId}
            />
          );
        }}
        selectOnClick
        tree={tree}
        withLines
      />
    </Stack>
  );
}
