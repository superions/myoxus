// SPDX-License-Identifier: AGPL-3.0-or-later

import { ActionIcon, Box, Card, Group, Menu, Tooltip } from "@mantine/core";

import { MoreHorizontalIcon, TrashIcon } from "@myoxus/icons/react";
import { cssVar } from "@myoxus/theme";
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { DragHandle } from "../../drag-handle";
import {
  SurfaceListItem,
  SurfaceListItemMain,
  SurfaceListText,
} from "../../surface-list";
import { DropIndicator } from "../../dnd/drop-indicator";
import { useDraggable } from "../../dnd/draggable";
import { useDropTarget } from "../../dnd/drop-target";

import { InlineEdit, type InlineEditHandle } from "../../inline-edit";

import type {
  KanbanAccentRole,
  KanbanCardModel,
  KanbanColumnModel,
  KanbanCardMove,
  KanbanBoardLabels,
  KanbanBoardProps,
} from "./types";
import {
  wouldMoveKanbanCard,
  isKanbanActionTarget,
  type KanbanDndData,
  type KanbanKeyboardCardDrag,
} from "./kanban-dnd";
function accentToken(role: KanbanAccentRole) {
  switch (role) {
    case "tag.red":
      return cssVar("paletteLineRed");
    case "tag.magenta":
      return cssVar("paletteLineMagenta");
    case "tag.orange":
      return cssVar("paletteLineOrange");
    case "tag.yellow":
      return cssVar("paletteLineYellow");
    case "tag.green":
      return cssVar("paletteLineGreen");
    case "tag.teal":
      return cssVar("paletteLineTeal");
    case "tag.blue":
      return cssVar("paletteLineBlue");
    case "tag.purple":
      return cssVar("paletteLinePurple");
    case "tag.grey":
      return cssVar("paletteLineGrey");
  }
}

function resolveAccent(roles: readonly KanbanAccentRole[]) {
  return [...new Set(roles)]
    .sort()
    .map(accentToken)
    .reduce<string | undefined>(
      (mixed, color) =>
        mixed ? `color-mix(in srgb, ${mixed} 50%, ${color} 50%)` : color,
      undefined,
    );
}

export function KanbanBoardCard({
  card,
  boardId,
  columnIndex,
  columns,
  labels,
  renderLabel,
  readonly,
  appearance = "default",
  activation = "select",
  order = "manual",
  keyboardMovement = "grab",
  selected,
  onInteractionStart,
  onEditEnd,
  onMoveCard,
  onOpenCard,
  onSelectCard,
  onRenameCard,
  onDeleteCard,
  editRequest,
  keyboardDrag,
  onKeyboardDragChange,
  announce,
}: {
  card: KanbanCardModel;
  boardId: string;
  columnIndex: number;
  columns: ReadonlyArray<KanbanColumnModel>;
  labels: KanbanBoardLabels;
  renderLabel?: KanbanBoardProps["renderLabel"];
  readonly: boolean;
  appearance?: KanbanBoardProps["appearance"];
  activation?: KanbanBoardProps["activation"];
  order?: KanbanBoardProps["order"];
  keyboardMovement?: KanbanBoardProps["keyboardMovement"];
  selected: boolean;
  onInteractionStart?: KanbanBoardProps["onInteractionStart"];
  onEditEnd?: KanbanBoardProps["onEditEnd"];
  onMoveCard?: KanbanBoardProps["onMoveCard"];
  onOpenCard?: KanbanBoardProps["onOpenCard"];
  onSelectCard?: KanbanBoardProps["onSelectCard"];
  onRenameCard?: KanbanBoardProps["onRenameCard"];
  onDeleteCard?: KanbanBoardProps["onDeleteCard"];
  editRequest?: KanbanBoardProps["editRequest"];
  keyboardDrag: KanbanKeyboardCardDrag | null;
  onKeyboardDragChange: (drag: KanbanKeyboardCardDrag | null) => void;
  announce: (message: string) => void;
}) {
  const [interactionDisabled, setInteractionDisabled] = useState(false);
  const editHandleRef = useRef<InlineEditHandle>(null);
  const handledEditRequestRef = useRef<number | undefined>(undefined);
  const cardElementRef = useRef<HTMLElement | null>(null);
  const interaction = useMemo(() => ({ setInteractionDisabled }), []);
  const movable =
    !interactionDisabled &&
    !readonly &&
    card.move?.enabled !== false &&
    onMoveCard;
  const openable =
    !interactionDisabled && card.open?.enabled !== false && onOpenCard;
  const removable =
    !readonly && card.remove?.enabled !== false && Boolean(onDeleteCard);
  const selectable = !interactionDisabled && Boolean(onSelectCard);
  const keyboardTarget = keyboardDrag?.cardId === card.id ? keyboardDrag : null;
  const keyboardDropEdge = useMemo(() => {
    if (
      order === "external" ||
      !keyboardDrag ||
      keyboardDrag.columnIndex !== columnIndex
    )
      return null;
    const targetCards = columns[columnIndex]?.cards.filter(
      (candidate) => candidate.id !== keyboardDrag.cardId,
    );
    if (!targetCards?.length) return null;
    const targetIndex = targetCards.findIndex(
      (candidate) => candidate.id === card.id,
    );
    if (targetIndex === keyboardDrag.insertionIndex) return "top";
    if (
      keyboardDrag.insertionIndex === targetCards.length &&
      targetIndex === targetCards.length - 1
    ) {
      return "bottom";
    }
    return null;
  }, [card.id, columnIndex, columns, keyboardDrag, order]);
  useEffect(() => {
    if (
      editRequest?.kind !== "card" ||
      editRequest.id !== card.id ||
      handledEditRequestRef.current === editRequest.requestId
    ) {
      return;
    }
    handledEditRequestRef.current = editRequest.requestId;
    editHandleRef.current?.triggerEdit();
  }, [card.id, editRequest]);
  useEffect(() => {
    if (keyboardTarget && !movable) onKeyboardDragChange(null);
  }, [keyboardTarget, movable, onKeyboardDragChange]);
  const { dragRef, dragHandleRef, dragging } = useDraggable<KanbanDndData>(
    () => ({
      canDrag: Boolean(movable),
      data: {
        type: "kanban-card",
        boardId,
        cardId: card.id,
        columnId: card.columnId,
      },
      dragPreviewPosition: "pointer-outside",
    }),
    [boardId, card.columnId, card.id, movable],
  );
  const { closestEdge, draggedOver, dropTargetRef } =
    useDropTarget<KanbanDndData>(
      () => ({
        canDrop: ({ source }) =>
          order === "manual" &&
          !interactionDisabled &&
          !readonly &&
          Boolean(onMoveCard) &&
          card.move?.enabled !== false &&
          columns.find((column) => column.id === card.columnId)?.receive
            ?.enabled !== false &&
          source.data.boardId === boardId &&
          source.data.type === "kanban-card" &&
          source.data.cardId !== card.id,
        closestEdge: { allowedEdges: ["top", "bottom"] },
        data: {
          type: "kanban-card",
          boardId,
          cardId: card.id,
          columnId: card.columnId,
        },
        dropEffect: "move",
        onDrop: async ({ source, closestEdge: edge }) => {
          if (
            source.data.boardId !== boardId ||
            source.data.type !== "kanban-card" ||
            (edge !== "top" && edge !== "bottom")
          ) {
            return;
          }
          const { cardId: sourceCardId, columnId: sourceColumnId } =
            source.data;
          const move: KanbanCardMove = {
            cardId: sourceCardId,
            fromColumnId: sourceColumnId,
            toColumnId: card.columnId,
            targetCardId: card.id,
            edge: edge === "top" ? "before" : "after",
          };
          if (!wouldMoveKanbanCard(columns, move, order)) return;
          if ((await onMoveCard?.(move)) === false) return;
          const sourceColumn = columns.find(
            (column) => column.id === sourceColumnId,
          );
          const sourceCard = sourceColumn?.cards.find(
            (candidate) => candidate.id === sourceCardId,
          );
          if (sourceColumn && sourceCard) {
            announce(
              labels.movedCard(
                sourceCard.label,
                sourceColumn.label,
                columns[columnIndex]?.label ?? sourceColumn.label,
              ),
            );
          }
        },
      }),
      [
        announce,
        boardId,
        card.columnId,
        card.id,
        columnIndex,
        columns,
        labels,
        onMoveCard,
        readonly,
        order,
        interactionDisabled,
      ],
    );
  const cardRef = useCallback(
    (node: HTMLElement | null) => {
      cardElementRef.current = node;
      dragRef.current = node;
      dropTargetRef.current = node;
    },
    [dragRef, dropTargetRef],
  );
  const handleKeyboardDrag = async (event: KeyboardEvent<HTMLDivElement>) => {
    if (!movable || keyboardMovement !== "grab") return;
    if (event.key === "Escape" && (keyboardTarget !== null || dragging)) {
      event.preventDefault();
      onKeyboardDragChange(null);
      return;
    }
    if (
      keyboardTarget !== null &&
      (event.key === "ArrowLeft" ||
        event.key === "ArrowRight" ||
        event.key === "ArrowUp" ||
        event.key === "ArrowDown")
    ) {
      event.preventDefault();
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        const delta = event.key === "ArrowLeft" ? -1 : 1;
        let nextColumnIndex = keyboardTarget.columnIndex + delta;
        while (
          nextColumnIndex >= 0 &&
          nextColumnIndex < columns.length &&
          columns[nextColumnIndex]?.receive?.enabled === false
        )
          nextColumnIndex += delta;
        if (nextColumnIndex < 0 || nextColumnIndex >= columns.length) return;
        const targetCards =
          columns[nextColumnIndex]?.cards.filter(
            (candidate) => candidate.id !== card.id,
          ) ?? [];
        onKeyboardDragChange({
          cardId: card.id,
          columnIndex: nextColumnIndex,
          insertionIndex: Math.min(
            keyboardTarget.insertionIndex,
            targetCards.length,
          ),
        });
        return;
      }
      if (order === "external") return;
      const targetCards =
        columns[keyboardTarget.columnIndex]?.cards.filter(
          (candidate) => candidate.id !== card.id,
        ) ?? [];
      onKeyboardDragChange({
        cardId: card.id,
        columnIndex: keyboardTarget.columnIndex,
        insertionIndex: Math.max(
          0,
          Math.min(
            targetCards.length,
            keyboardTarget.insertionIndex + (event.key === "ArrowUp" ? -1 : 1),
          ),
        ),
      });
      return;
    }
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    if (keyboardTarget === null) {
      onInteractionStart?.("card", card.id, "move");
      const sourceCards =
        columns[columnIndex]?.cards.filter(
          (candidate) => candidate.id !== card.id,
        ) ?? [];
      const sourceIndex =
        columns[columnIndex]?.cards.findIndex(
          (candidate) => candidate.id === card.id,
        ) ?? -1;
      onKeyboardDragChange({
        cardId: card.id,
        columnIndex,
        insertionIndex:
          sourceIndex < 0
            ? sourceCards.length
            : Math.min(sourceIndex, sourceCards.length),
      });
      return;
    }
    const target = columns[keyboardTarget.columnIndex];
    const targetCards =
      target?.cards.filter((candidate) => candidate.id !== card.id) ?? [];
    if (target) {
      const targetCardId = targetCards[keyboardTarget.insertionIndex]?.id;
      const move: KanbanCardMove = {
        cardId: card.id,
        fromColumnId: card.columnId,
        toColumnId: target.id,
        targetCardId,
        edge: targetCardId ? "before" : undefined,
      };
      if (!wouldMoveKanbanCard(columns, move, order)) {
        onKeyboardDragChange(null);
        return;
      }
      if ((await onMoveCard?.(move)) === false) {
        onKeyboardDragChange(null);
        return;
      }
      const source = columns[columnIndex];
      if (source) {
        announce(labels.movedCard(card.label, source.label, target.label));
      }
    }
    onKeyboardDragChange(null);
  };
  const moveAdjacent = async (delta: -1 | 1) => {
    if (!movable || keyboardMovement !== "adjacent-column") return;
    let targetIndex = columnIndex + delta;
    while (
      targetIndex >= 0 &&
      targetIndex < columns.length &&
      columns[targetIndex]?.receive?.enabled === false
    )
      targetIndex += delta;
    const target = columns[targetIndex];
    if (!target) return;
    const move: KanbanCardMove = {
      cardId: card.id,
      fromColumnId: card.columnId,
      toColumnId: target.id,
    };
    if (!wouldMoveKanbanCard(columns, move, order)) return;
    onInteractionStart?.("card", card.id, "move");
    if ((await onMoveCard?.(move)) !== false) {
      announce(
        labels.movedCard(card.label, columns[columnIndex]!.label, target.label),
      );
    }
  };
  const surface = appearance === "surface";
  const Frame = surface ? SurfaceListItem : Card;
  const title =
    typeof card.title === "function" ? card.title(interaction) : card.title;
  const content = (
    <Frame
      ref={cardRef}
      {...(surface
        ? {
            appearance: "card" as const,
            layout: "column" as const,
            density: card.density,
            accentTagColorRoles: card.accentRoles,
            interactive:
              Boolean(openable || selectable) && !interactionDisabled,
            selected:
              selected || dragging || draggedOver || keyboardTarget !== null,
          }
        : { withBorder: true })}
      className="mantine-focus-auto"
      aria-current={selected ? "true" : undefined}
      p={
        surface
          ? undefined
          : card.density === "compact"
            ? "xs"
            : card.density === "card"
              ? "lg"
              : "sm"
      }
      data-myoxus-ui-role="kanban-card"
      data-card-id={card.id}
      {...card.dataAttributes}
      data-selected={
        selected || dragging || draggedOver || keyboardTarget !== null
          ? "true"
          : undefined
      }
      data-testid={card.testId ?? "kanban-card"}
      data-density={card.density}
      role={activation === "open" && openable ? "button" : "group"}
      tabIndex={selectable || openable ? 0 : undefined}
      aria-label={card.description ?? card.label}
      onPointerDown={(event) => {
        if (
          activation === "select" &&
          !interactionDisabled &&
          !isKanbanActionTarget(event.target)
        ) {
          onSelectCard?.(card.id, event.currentTarget);
        }
      }}
      onClick={(event) => {
        if (
          activation === "open" &&
          openable &&
          !dragging &&
          !isKanbanActionTarget(event.target)
        ) {
          onOpenCard?.(card.id, event.currentTarget);
        }
      }}
      // Reuse the Facade selection border; Card actions preclude a nested-button SelectableCardRow root.
      style={
        surface
          ? undefined
          : {
              borderColor: selected ? cssVar("primaryColor") : undefined,
              borderInlineStartColor: card.accentRoles?.length
                ? resolveAccent(card.accentRoles)
                : undefined,
              borderInlineStartWidth: card.accentRoles?.length
                ? "calc(var(--mantine-scale) * 2px)"
                : undefined,
            }
      }
      onDoubleClick={(event) => {
        if (
          activation !== "select" ||
          event.target !== event.currentTarget ||
          !openable
        )
          return;
        event.preventDefault();
        onOpenCard?.(card.id, event.currentTarget);
      }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (interactionDisabled) return;
        if (
          activation === "open" &&
          openable &&
          (event.key === "Enter" || event.key === " ")
        ) {
          event.preventDefault();
          onOpenCard?.(card.id, event.currentTarget);
          return;
        }
        if (event.key === "F2" && !readonly && card.rename?.enabled !== false) {
          event.preventDefault();
          editHandleRef.current?.triggerEdit();
          return;
        }
        if (event.key === " " && selectable) {
          event.preventDefault();
          onSelectCard?.(card.id, event.currentTarget);
          return;
        }
        if (event.key !== "Enter" || !openable) return;
        event.preventDefault();
        onOpenCard?.(card.id, event.currentTarget);
      }}
    >
      <DropIndicator edge={closestEdge ?? keyboardDropEdge} />
      {surface ? (
        <SurfaceListItemMain>
          {card.cover}
          <Group justify="space-between" wrap="nowrap">
            <SurfaceListText
              kind="card-title"
              component="div"
              truncate={title ? undefined : false}
              lineClamp={title ? undefined : 2}
            >
              {title ?? (renderLabel ? renderLabel(card.label) : card.label)}
            </SurfaceListText>
            {movable ? (
              <DragHandle
                ref={dragHandleRef}
                aria-label={labels.dragCard(card.label)}
                dragging={dragging || keyboardTarget !== null}
                onKeyDown={handleKeyboardDrag}
                onKeyboardMove={
                  keyboardMovement === "adjacent-column"
                    ? (delta) => void moveAdjacent(delta)
                    : undefined
                }
                onPointerDown={() => {
                  onInteractionStart?.("card", card.id, "move");
                  onKeyboardDragChange(null);
                }}
                data-myoxus-kanban-interaction="drag"
              />
            ) : null}
          </Group>
          {typeof card.content === "function"
            ? card.content(interaction)
            : card.content}
        </SurfaceListItemMain>
      ) : (
        <>
          {card.cover}
          <Group justify="space-between" wrap="nowrap" align="flex-start">
            {typeof card.title === "function"
              ? card.title(interaction)
              : (card.title ?? (
                  <Tooltip label={card.label} openDelay={500}>
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
                          onSelectCard?.(card.id, event.currentTarget);
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
                          onSelectCard?.(card.id, event.currentTarget);
                        } else if (event.key === "Enter") {
                          event.preventDefault();
                          onOpenCard?.(card.id, event.currentTarget);
                        }
                      }}
                    >
                      <InlineEdit
                        handleRef={editHandleRef}
                        editable={
                          !readonly &&
                          card.rename?.enabled !== false &&
                          Boolean(onRenameCard)
                        }
                        trigger="doubleClick"
                        value={card.label}
                        renderDisplay={renderLabel}
                        displayLineClamp={2}
                        onChange={(label) =>
                          void onRenameCard?.(card.id, label)
                        }
                        onEditStart={() => {
                          onInteractionStart?.("card", card.id, "rename");
                          setInteractionDisabled(true);
                        }}
                        onEditEnd={(outcome) => {
                          setInteractionDisabled(false);
                          onEditEnd?.("card", card.id, outcome);
                        }}
                        inputAttrs={{
                          "aria-label":
                            card.label ||
                            labels.addCard(columns[columnIndex]!.label),
                        }}
                      />
                    </Box>
                  </Tooltip>
                ))}
            {!readonly ? (
              <DragHandle
                ref={dragHandleRef}
                aria-label={labels.dragCard(card.label)}
                disabled={!movable}
                dragging={dragging || keyboardTarget !== null}
                onKeyDown={handleKeyboardDrag}
                onKeyboardMove={
                  keyboardMovement === "adjacent-column"
                    ? (delta) => void moveAdjacent(delta)
                    : undefined
                }
                onPointerDown={() => {
                  onInteractionStart?.("card", card.id, "move");
                  onKeyboardDragChange(null);
                }}
                aria-pressed={keyboardTarget !== null}
                data-myoxus-kanban-interaction="drag"
              />
            ) : null}
          </Group>
          {typeof card.content === "function"
            ? card.content(interaction)
            : card.content}
        </>
      )}
      {card.actions ||
      (card.defaultActions !== false && (openable || removable)) ? (
        <Group justify="flex-end" gap="xs" wrap="nowrap">
          {card.actions ? (
            <Box data-myoxus-kanban-interaction="custom-actions">
              {card.actions}
            </Box>
          ) : null}
          {card.defaultActions !== false && (openable || removable) ? (
            <Menu position="bottom-end" withinPortal>
              <Menu.Target>
                <ActionIcon
                  variant="subtle"
                  aria-label={`${labels.actions}: ${card.label}`}
                  data-myoxus-kanban-interaction="actions"
                >
                  <MoreHorizontalIcon />
                </ActionIcon>
              </Menu.Target>
              <Menu.Dropdown>
                {openable ? (
                  <Menu.Item
                    onClick={(event) =>
                      onOpenCard?.(
                        card.id,
                        cardElementRef.current ?? event.currentTarget,
                      )
                    }
                  >
                    {labels.openCard(card.label)}
                  </Menu.Item>
                ) : null}
                {removable ? (
                  <Menu.Item
                    color="myoxusError"
                    leftSection={<TrashIcon />}
                    onClick={() => void onDeleteCard?.(card.id)}
                  >
                    {labels.deleteCard(card.label)}
                  </Menu.Item>
                ) : null}
              </Menu.Dropdown>
            </Menu>
          ) : null}
        </Group>
      ) : null}
    </Frame>
  );
  const framed = card.frame ? card.frame(content, { dragging }) : content;
  return (
    <Box component="li" data-myoxus-ui-role="kanban-card-item" role="listitem">
      {card.precedingContent}
      {framed}
    </Box>
  );
}
