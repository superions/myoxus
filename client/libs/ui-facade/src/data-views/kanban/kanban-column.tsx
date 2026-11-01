// SPDX-License-Identifier: AGPL-3.0-or-later

import { cssVar } from "@myoxus/theme";
import {
  ActionIcon,
  Badge,
  Box,
  Button,
  Card,
  Group,
  Menu,
  Stack,
  Text,
  Tooltip,
} from "@mantine/core";

import { MoreHorizontalIcon, PlusIcon, TrashIcon } from "@myoxus/icons/react";

import { Fragment, useCallback, useEffect, useRef } from "react";

import { DragHandle } from "../../drag-handle";
import { SurfaceListItem, SurfaceListText } from "../../surface-list";
import { Badge as SurfaceBadge } from "../../badge";
import { Button as SurfaceButton } from "../../button";
import { DropIndicator } from "../../dnd/drop-indicator";
import { useDraggable } from "../../dnd/draggable";
import { useDropTarget } from "../../dnd/drop-target";

import { InlineEdit, type InlineEditHandle } from "../../inline-edit";

import type {
  KanbanSelection,
  KanbanColumnModel,
  KanbanCardMove,
  KanbanColumnMove,
  KanbanBoardLabels,
  KanbanBoardProps,
} from "./types";
import {
  wouldMoveKanbanCard,
  wouldMoveKanbanColumn,
  isKanbanActionTarget,
  type KanbanDndData,
  type KanbanKeyboardCardDrag,
  type KanbanKeyboardColumnDrag,
} from "./kanban-dnd";
import { KanbanBoardCard } from "./kanban-card";
export function KanbanColumn({
  column,
  boardId,
  columnIndex,
  columns,
  labels,
  renderLabel,
  readonly,
  appearance,
  activation,
  order,
  keyboardMovement,
  selection,
  onAddCard,
  onInteractionStart,
  onEditEnd,
  onOpenColumn,
  onMoveCard,
  onOpenCard,
  onSelectCard,
  onSelectColumn,
  onRenameCard,
  onRenameColumn,
  onDeleteCard,
  onDeleteColumn,
  onMoveColumn,
  editRequest,
  keyboardCardDrag,
  keyboardColumnDrag,
  onKeyboardCardDragChange,
  onKeyboardColumnDragChange,
  announce,
}: {
  column: KanbanColumnModel;
  boardId: string;
  columnIndex: number;
  columns: ReadonlyArray<KanbanColumnModel>;
  labels: KanbanBoardLabels;
  renderLabel?: KanbanBoardProps["renderLabel"];
  readonly: boolean;
  appearance: NonNullable<KanbanBoardProps["appearance"]>;
  activation: NonNullable<KanbanBoardProps["activation"]>;
  order: NonNullable<KanbanBoardProps["order"]>;
  keyboardMovement: NonNullable<KanbanBoardProps["keyboardMovement"]>;
  selection?: KanbanSelection;
  onAddCard?: KanbanBoardProps["onAddCard"];
  onInteractionStart?: KanbanBoardProps["onInteractionStart"];
  onEditEnd?: KanbanBoardProps["onEditEnd"];
  onOpenColumn?: KanbanBoardProps["onOpenColumn"];
  onMoveCard?: KanbanBoardProps["onMoveCard"];
  onOpenCard?: KanbanBoardProps["onOpenCard"];
  onSelectCard?: KanbanBoardProps["onSelectCard"];
  onSelectColumn?: KanbanBoardProps["onSelectColumn"];
  onRenameCard?: KanbanBoardProps["onRenameCard"];
  onRenameColumn?: KanbanBoardProps["onRenameColumn"];
  onDeleteCard?: KanbanBoardProps["onDeleteCard"];
  onDeleteColumn?: KanbanBoardProps["onDeleteColumn"];
  onMoveColumn?: KanbanBoardProps["onMoveColumn"];
  editRequest?: KanbanBoardProps["editRequest"];
  keyboardCardDrag: KanbanKeyboardCardDrag | null;
  keyboardColumnDrag: KanbanKeyboardColumnDrag | null;
  onKeyboardCardDragChange: (drag: KanbanKeyboardCardDrag | null) => void;
  onKeyboardColumnDragChange: (drag: KanbanKeyboardColumnDrag | null) => void;
  announce: (message: string) => void;
}) {
  const editHandleRef = useRef<InlineEditHandle>(null);
  const handledEditRequestRef = useRef<number | undefined>(undefined);
  const columnElementRef = useRef<HTMLElement | null>(null);
  const keyboardColumnIndex =
    keyboardColumnDrag?.columnId === column.id
      ? keyboardColumnDrag.targetIndex
      : null;
  const keyboardColumnDropEdge =
    keyboardColumnDrag &&
    keyboardColumnDrag.columnId !== column.id &&
    keyboardColumnDrag.targetIndex === columnIndex
      ? columnIndex <
        columns.findIndex(
          (candidate) => candidate.id === keyboardColumnDrag.columnId,
        )
        ? "left"
        : "right"
      : null;
  const keyboardCardDropIntoEmpty = Boolean(
    keyboardCardDrag &&
    keyboardCardDrag.columnIndex === columnIndex &&
    columns.some(
      (candidate, candidateIndex) =>
        candidateIndex !== columnIndex &&
        candidate.cards.some((card) => card.id === keyboardCardDrag.cardId),
    ) &&
    column.cards.every((card) => card.id === keyboardCardDrag.cardId),
  );
  const movableColumn =
    !readonly && column.reorder?.enabled !== false && onMoveColumn;
  const {
    dragRef: columnDragRef,
    dragHandleRef: columnDragHandleRef,
    dragging: columnDragging,
  } = useDraggable<KanbanDndData>(
    () => ({
      canDrag: Boolean(movableColumn),
      data: { type: "kanban-column", boardId, columnId: column.id },
      dragPreviewPosition: "pointer-outside",
    }),
    [boardId, column.id, movableColumn],
  );
  const showAdd =
    (appearance === "surface" || !readonly) &&
    column.add !== undefined &&
    Boolean(onAddCard);
  const canAdd = !readonly && column.add?.enabled !== false;
  useEffect(() => {
    if (
      editRequest?.kind !== "column" ||
      editRequest.id !== column.id ||
      handledEditRequestRef.current === editRequest.requestId
    ) {
      return;
    }
    handledEditRequestRef.current = editRequest.requestId;
    editHandleRef.current?.triggerEdit();
  }, [column.id, editRequest]);
  const {
    closestEdge: columnClosestEdge,
    draggedOver,
    dropTargetRef,
  } = useDropTarget<KanbanDndData>(
    () => ({
      canDrop: ({ source }) =>
        !readonly &&
        source.data.boardId === boardId &&
        ((Boolean(onMoveCard) &&
          column.receive?.enabled !== false &&
          source.data.type === "kanban-card" &&
          wouldMoveKanbanCard(
            columns,
            {
              cardId: source.data.cardId,
              fromColumnId: source.data.columnId,
              toColumnId: column.id,
            },
            order,
          )) ||
          (Boolean(onMoveColumn) &&
            source.data.type === "kanban-column" &&
            column.reorder?.enabled !== false &&
            source.data.columnId !== column.id)),
      closestEdge: { allowedEdges: ["left", "right"] },
      data: { type: "kanban-column", boardId, columnId: column.id },
      dropEffect: "move",
      onDrop: async ({ source, location, closestEdge }) => {
        if (source.data.boardId !== boardId) return;
        if (source.data.type === "kanban-column") {
          if (closestEdge !== "left" && closestEdge !== "right") return;
          const movingColumnId = source.data.columnId;
          const move: KanbanColumnMove = {
            columnId: movingColumnId,
            targetColumnId: column.id,
            edge: closestEdge === "left" ? "before" : "after",
          };
          if (!wouldMoveKanbanColumn(columns, move)) return;
          if ((await onMoveColumn?.(move)) === false) return;
          const movingColumn = columns.find(
            (candidate) => candidate.id === movingColumnId,
          );
          if (movingColumn) {
            announce(labels.movedColumn(movingColumn.label, column.label));
          }
          return;
        }
        if (source.data.type !== "kanban-card") return;
        const { cardId: sourceCardId, columnId: sourceColumnId } = source.data;
        const hasCardTarget = location.current.dropTargets.some(
          (target) =>
            (target.data as KanbanDndData["dropTarget"] | undefined)?.type ===
            "kanban-card",
        );
        if (hasCardTarget) return;
        const sourceColumn = columns.find(
          (candidate) => candidate.id === sourceColumnId,
        );
        const sourceCard = sourceColumn?.cards.find(
          (candidate) => candidate.id === sourceCardId,
        );
        const move: KanbanCardMove = {
          cardId: sourceCardId,
          fromColumnId: sourceColumnId,
          toColumnId: column.id,
        };
        if (!wouldMoveKanbanCard(columns, move, order)) return;
        if ((await onMoveCard?.(move)) === false) return;
        if (sourceColumn && sourceCard) {
          announce(
            labels.movedCard(
              sourceCard.label,
              sourceColumn.label,
              column.label,
            ),
          );
        }
      },
    }),
    [
      announce,
      boardId,
      column.id,
      columns,
      labels,
      onMoveCard,
      onMoveColumn,
      readonly,
      order,
      column.receive?.enabled,
    ],
  );
  const columnRef = useCallback(
    (node: HTMLElement | null) => {
      columnElementRef.current = node;
      dropTargetRef.current = node;
      columnDragRef.current = node;
    },
    [columnDragRef, dropTargetRef],
  );
  const surface = appearance === "surface";
  const Frame = surface ? SurfaceListItem : Card;
  const CardsBody = surface ? Stack : Fragment;
  const content = (
    <Box
      component="li"
      style={{ inlineSize: column.width }}
      data-myoxus-ui-role="kanban-column-frame"
      data-testid={column.frameTestId ?? "kanban-column-frame"}
      role="listitem"
    >
      {column.precedingContent}
      <Frame
        ref={columnRef}
        {...(surface
          ? {
              appearance: "card" as const,
              layout: "column" as const,
              selected: draggedOver,
            }
          : { withBorder: true })}
        className="mantine-focus-auto"
        aria-current={selection?.columnId === column.id ? "true" : undefined}
        style={
          surface
            ? undefined
            : {
                borderColor:
                  selection?.columnId === column.id
                    ? cssVar("primaryColor")
                    : undefined,
              }
        }
        data-myoxus-ui-role="kanban-column"
        data-column-id={column.id}
        data-selected={
          selection?.columnId === column.id ||
          draggedOver ||
          columnDragging ||
          keyboardColumnIndex !== null
            ? "true"
            : undefined
        }
        data-testid={column.testId ?? "kanban-column"}
        role="group"
        tabIndex={onSelectColumn ? 0 : undefined}
        aria-label={column.label}
        onPointerDown={(event) => {
          if (
            (!(event.target instanceof Element) ||
              !event.target.closest("[data-card-id]")) &&
            !isKanbanActionTarget(event.target)
          ) {
            onSelectColumn?.(column.id, event.currentTarget);
          }
        }}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (
            event.key === "F2" &&
            !readonly &&
            column.rename?.enabled !== false
          ) {
            event.preventDefault();
            editHandleRef.current?.triggerEdit();
            return;
          }
          if (event.key === "Enter" && onOpenColumn) {
            event.preventDefault();
            onOpenColumn(column.id, event.currentTarget);
            return;
          }
          if (event.key === " ") {
            event.preventDefault();
            onSelectColumn?.(column.id, event.currentTarget);
          }
        }}
      >
        <DropIndicator edge={columnClosestEdge ?? keyboardColumnDropEdge} />
        {surface ? (
          <Group justify="space-between" wrap="nowrap">
            <SurfaceListText kind="title" component="span">
              {column.label}
            </SurfaceListText>
            <Group gap="xs" wrap="nowrap">
              <SurfaceBadge
                tone="neutral"
                aria-label={labels.cardCount(column.cards.length)}
              >
                {column.cards.length}
              </SurfaceBadge>
              {column.actions ? (
                <Box data-myoxus-kanban-interaction="custom-actions">
                  {column.actions}
                </Box>
              ) : null}
            </Group>
          </Group>
        ) : (
          <Stack>
            <Group justify="space-between" wrap="nowrap">
              <Box flex="1 1 auto" miw={0}>
                <Tooltip label={column.label} openDelay={500}>
                  <Box
                    miw={0}
                    w="100%"
                    onClickCapture={(event) => {
                      if (
                        event.target instanceof Element &&
                        event.target.closest(
                          '[data-myoxus-ui-role="inline-edit-display"]',
                        )
                      )
                        onSelectColumn?.(column.id, event.currentTarget);
                    }}
                    onKeyDownCapture={(event) => {
                      if (
                        !(event.target instanceof Element) ||
                        !event.target.closest(
                          '[data-myoxus-ui-role="inline-edit-display"]',
                        )
                      )
                        return;
                      if (event.key === " ") {
                        event.preventDefault();
                        onSelectColumn?.(column.id, event.currentTarget);
                      } else if (event.key === "Enter") {
                        event.preventDefault();
                        onOpenColumn?.(column.id, event.currentTarget);
                      }
                    }}
                  >
                    <InlineEdit
                      handleRef={editHandleRef}
                      editable={
                        !readonly &&
                        column.rename?.enabled !== false &&
                        Boolean(onRenameColumn)
                      }
                      trigger="doubleClick"
                      value={column.label}
                      renderDisplay={renderLabel}
                      onEditStart={() =>
                        onInteractionStart?.("column", column.id, "rename")
                      }
                      onEditEnd={(outcome) =>
                        onEditEnd?.("column", column.id, outcome)
                      }
                      displayLineClamp={1}
                      onChange={(label) =>
                        void onRenameColumn?.(column.id, label)
                      }
                      inputAttrs={{
                        "aria-label": column.label || labels.addColumn,
                      }}
                    />
                  </Box>
                </Tooltip>
              </Box>
              <Badge
                variant="light"
                aria-label={labels.cardCount(column.cards.length)}
              >
                {column.cards.length}
              </Badge>
            </Group>
            <Group justify="space-between" wrap="nowrap">
              {column.actions ? (
                <Box data-myoxus-kanban-interaction="custom-actions">
                  {column.actions}
                </Box>
              ) : null}
              {movableColumn ? (
                <DragHandle
                  ref={columnDragHandleRef}
                  aria-label={labels.dragColumn(column.label)}
                  dragging={columnDragging || keyboardColumnIndex !== null}
                  onKeyboardMove={(delta) => {
                    if (keyboardColumnIndex === null) return;
                    const nextIndex = Math.max(
                      0,
                      Math.min(columns.length - 1, keyboardColumnIndex + delta),
                    );
                    const target = columns[nextIndex];
                    if (!target || nextIndex === keyboardColumnIndex) return;
                    onKeyboardColumnDragChange({
                      columnId: column.id,
                      targetIndex: nextIndex,
                    });
                  }}
                  onKeyDown={async (event) => {
                    if (
                      event.key === "Escape" &&
                      (keyboardColumnIndex !== null || columnDragging)
                    ) {
                      event.preventDefault();
                      onKeyboardColumnDragChange(null);
                      return;
                    }
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    if (keyboardColumnIndex === null) {
                      onInteractionStart?.("column", column.id, "move");
                      onKeyboardColumnDragChange({
                        columnId: column.id,
                        targetIndex: columnIndex,
                      });
                      return;
                    }
                    const target = columns[keyboardColumnIndex];
                    if (target && target.id !== column.id) {
                      const accepted = await onMoveColumn?.({
                        columnId: column.id,
                        targetColumnId: target.id,
                        edge:
                          keyboardColumnIndex < columnIndex
                            ? "before"
                            : "after",
                      });
                      if (accepted !== false)
                        announce(
                          labels.movedColumn(column.label, target.label),
                        );
                    }
                    onKeyboardColumnDragChange(null);
                  }}
                  onPointerDown={() => {
                    onInteractionStart?.("column", column.id, "move");
                    onKeyboardColumnDragChange(null);
                  }}
                  aria-pressed={keyboardColumnIndex !== null}
                  data-myoxus-kanban-interaction="drag"
                />
              ) : null}
              {onOpenColumn ||
              (!readonly &&
                column.remove?.enabled !== false &&
                onDeleteColumn) ? (
                <Menu position="bottom-end" withinPortal>
                  <Menu.Target>
                    <ActionIcon
                      variant="subtle"
                      aria-label={`${labels.actions}: ${column.label}`}
                      data-myoxus-kanban-interaction="actions"
                    >
                      <MoreHorizontalIcon />
                    </ActionIcon>
                  </Menu.Target>
                  <Menu.Dropdown>
                    {onOpenColumn ? (
                      <Menu.Item
                        onClick={(event) =>
                          onOpenColumn(
                            column.id,
                            columnElementRef.current ?? event.currentTarget,
                          )
                        }
                      >
                        {labels.openCard(column.label)}
                      </Menu.Item>
                    ) : null}
                    {!readonly &&
                    onDeleteColumn &&
                    column.remove?.enabled !== false ? (
                      <Menu.Item
                        color="myoxusError"
                        leftSection={<TrashIcon />}
                        onClick={(event) =>
                          void onDeleteColumn(
                            column.id,
                            columnElementRef.current ?? event.currentTarget,
                          )
                        }
                      >
                        {labels.deleteColumn(column.label)}
                      </Menu.Item>
                    ) : null}
                  </Menu.Dropdown>
                </Menu>
              ) : null}
            </Group>
          </Stack>
        )}
        {!surface && column.cards.length === 0 ? (
          <Box pos="relative">
            <DropIndicator edge={keyboardCardDropIntoEmpty ? "bottom" : null} />
            <Text
              c="dimmed"
              size="sm"
              data-myoxus-ui-role="kanban-empty-column"
            >
              {labels.emptyColumn}
            </Text>
          </Box>
        ) : null}
        <CardsBody {...(surface ? { gap: "xs" } : {})}>
          {column.cards.length || !surface ? (
            <Stack
              component="ul"
              gap="xs"
              data-myoxus-ui-role="kanban-card-list"
              role="list"
            >
              {column.cards.map((card) => (
                <KanbanBoardCard
                  key={card.id}
                  card={card}
                  boardId={boardId}
                  columnIndex={columnIndex}
                  columns={columns}
                  labels={labels}
                  renderLabel={renderLabel}
                  readonly={readonly}
                  appearance={appearance}
                  activation={activation}
                  order={order}
                  keyboardMovement={keyboardMovement}
                  selected={selection?.cardId === card.id}
                  editRequest={editRequest}
                  onInteractionStart={onInteractionStart}
                  onEditEnd={onEditEnd}
                  onMoveCard={onMoveCard}
                  onOpenCard={onOpenCard}
                  onSelectCard={onSelectCard}
                  onRenameCard={onRenameCard}
                  onDeleteCard={onDeleteCard}
                  keyboardDrag={keyboardCardDrag}
                  onKeyboardDragChange={onKeyboardCardDragChange}
                  announce={announce}
                />
              ))}
            </Stack>
          ) : null}
          {showAdd && surface ? (
            <SurfaceButton
              variant="ghost"
              size="sm"
              prefix={<PlusIcon />}
              aria-label={labels.addCard(column.label)}
              data-testid={
                column.addCardTestId ??
                (column.cards.length ? "kanban-column-new" : "kanban-empty-cta")
              }
              disabled={!canAdd}
              data-myoxus-kanban-interaction="add"
              onClick={() => void onAddCard?.(column.id)}
            >
              {labels.addCardText ?? labels.addCard(column.label)}
            </SurfaceButton>
          ) : showAdd ? (
            <Button
              variant="subtle"
              leftSection={<PlusIcon />}
              aria-label={labels.addCard(column.label)}
              data-testid={
                column.addCardTestId ??
                (column.cards.length === 0
                  ? "kanban-empty-cta"
                  : "kanban-column-new")
              }
              disabled={!canAdd}
              data-myoxus-kanban-interaction="add"
              onClick={() => void onAddCard?.(column.id)}
            >
              {labels.addCardText ?? labels.addCard(column.label)}
            </Button>
          ) : null}
        </CardsBody>
      </Frame>
    </Box>
  );
  return column.frame ? column.frame(content) : content;
}
