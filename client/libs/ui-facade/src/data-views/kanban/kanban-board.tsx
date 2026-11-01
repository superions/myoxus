// SPDX-License-Identifier: AGPL-3.0-or-later

import "./kanban.css";

import { Box, Button, Group, Stack, VisuallyHidden } from "@mantine/core";
import { PrimaryScrollArea } from "../primary-scroll-area";
import { Button as SurfaceButton } from "../../button";
import { PlusIcon } from "@myoxus/icons/react";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import { monitorForElements } from "../../dnd/monitor";

import type { KanbanBoardProps } from "./types";
import {
  type KanbanDndData,
  type KanbanKeyboardCardDrag,
  type KanbanKeyboardColumnDrag,
} from "./kanban-dnd";
import { KanbanColumn } from "./kanban-column";
export function KanbanBoard({
  columns,
  labels,
  renderLabel,
  selection,
  readonly = false,
  appearance = "default",
  activation = "select",
  order = "manual",
  keyboardMovement = "grab",
  scrollOwner = "self",
  toolbar,
  empty,
  error,
  addColumn,
  editRequest,
  focusRequest,
  onAddCard,
  onAddColumn,
  onInteractionStart,
  onEditEnd,
  onOpenColumn,
  onMoveCard,
  onMoveColumn,
  onOpenCard,
  onSelectionTargetChange,
  onSelectCard,
  onSelectColumn,
  onDeleteCard,
  onDeleteColumn,
  onRenameCard,
  onRenameColumn,
  "aria-label": ariaLabel,
  "data-testid": dataTestId,
}: KanbanBoardProps) {
  const boardId = useId();
  const [announcement, setAnnouncement] = useState({
    message: "",
    sequence: 0,
  });
  const [keyboardCardDrag, setKeyboardCardDrag] =
    useState<KanbanKeyboardCardDrag | null>(null);
  const [keyboardColumnDrag, setKeyboardColumnDrag] =
    useState<KanbanKeyboardColumnDrag | null>(null);
  const [moveFocusRequest, setMoveFocusRequest] =
    useState<KanbanBoardProps["focusRequest"]>();
  const moveCard = useCallback<NonNullable<KanbanBoardProps["onMoveCard"]>>(
    async (move) => {
      if (!onMoveCard) return false;
      const result = await onMoveCard(move);
      if (result !== false && keyboardMovement === "adjacent-column") {
        setMoveFocusRequest((previous) => ({
          requestId: (previous?.requestId ?? 0) + 1,
          selection: { cardId: move.cardId },
        }));
      }
      return result;
    },
    [keyboardMovement, onMoveCard],
  );
  const handledFocusRequestRef =
    useRef<KanbanBoardProps["focusRequest"]>(undefined);
  const boardRef = useRef<HTMLDivElement>(null);
  const scrollViewportRef = useRef<HTMLDivElement>(null);
  const autoScrollDirectionRef = useRef<-1 | 0 | 1>(0);
  const autoScrollFrameRef = useRef<number | undefined>(undefined);
  const selectionTargetChangeRef = useRef(onSelectionTargetChange);
  selectionTargetChangeRef.current = onSelectionTargetChange;
  const orderedColumns = useMemo(() => [...columns], [columns]);
  const canAddColumn = !readonly && addColumn?.enabled !== false && onAddColumn;
  const changeKeyboardCardDrag = useCallback(
    (drag: KanbanKeyboardCardDrag | null) => {
      setKeyboardCardDrag(drag);
      if (drag) setKeyboardColumnDrag(null);
    },
    [],
  );
  const changeKeyboardColumnDrag = useCallback(
    (drag: KanbanKeyboardColumnDrag | null) => {
      setKeyboardColumnDrag(drag);
      if (drag) setKeyboardCardDrag(null);
    },
    [],
  );
  const announce = useCallback((message: string) => {
    setAnnouncement((current) => ({
      message,
      sequence: current.sequence + 1,
    }));
  }, []);

  useEffect(() => {
    const keyboardCardSource = keyboardCardDrag
      ? columns
          .flatMap((column) => column.cards)
          .find((card) => card.id === keyboardCardDrag.cardId)
      : undefined;
    if (
      readonly ||
      (keyboardCardDrag &&
        (!onMoveCard ||
          keyboardCardDrag.columnIndex < 0 ||
          keyboardCardDrag.columnIndex >= columns.length ||
          !keyboardCardSource ||
          keyboardCardSource.move?.enabled === false))
    ) {
      setKeyboardCardDrag(null);
    }
    const keyboardColumnSource = keyboardColumnDrag
      ? columns.find((column) => column.id === keyboardColumnDrag.columnId)
      : undefined;
    if (
      readonly ||
      (keyboardColumnDrag &&
        (!onMoveColumn ||
          keyboardColumnDrag.targetIndex < 0 ||
          keyboardColumnDrag.targetIndex >= columns.length ||
          !keyboardColumnSource ||
          keyboardColumnSource.reorder?.enabled === false))
    ) {
      setKeyboardColumnDrag(null);
    }
  }, [
    columns,
    keyboardCardDrag,
    keyboardColumnDrag,
    onMoveCard,
    onMoveColumn,
    readonly,
  ]);

  useEffect(() => {
    const targetIndex =
      keyboardCardDrag?.columnIndex ?? keyboardColumnDrag?.targetIndex;
    const targetColumn =
      targetIndex === undefined ? undefined : columns[targetIndex];
    if (!targetColumn) return;
    const frame = window.requestAnimationFrame(() => {
      boardRef.current
        ?.querySelector<HTMLElement>(
          `[data-column-id="${CSS.escape(targetColumn.id)}"]`,
        )
        ?.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [columns, keyboardCardDrag, keyboardColumnDrag]);

  useEffect(() => {
    const stopAutoScroll = () => {
      autoScrollDirectionRef.current = 0;
      if (autoScrollFrameRef.current !== undefined) {
        window.cancelAnimationFrame(autoScrollFrameRef.current);
        autoScrollFrameRef.current = undefined;
      }
    };
    const scrollFrame = () => {
      const viewport = scrollViewportRef.current;
      const direction = autoScrollDirectionRef.current;
      if (!viewport || direction === 0) {
        autoScrollFrameRef.current = undefined;
        return;
      }
      // Pointer-edge scrolling is renderer geometry; scale it from the owned
      // scrollport instead of coupling Board to a route or viewport breakpoint.
      viewport.scrollBy({
        left: direction * Math.max(4, viewport.clientWidth * 0.015),
      });
      autoScrollFrameRef.current = window.requestAnimationFrame(scrollFrame);
    };
    const cleanupMonitor = monitorForElements({
      canMonitor: ({ source }) => {
        const data = source.data as KanbanDndData["draggable"] | undefined;
        const sourceBoard = source.element.closest(
          '[data-myoxus-ui-role="kanban-board"]',
        );
        return (
          !readonly &&
          sourceBoard === boardRef.current &&
          (data?.type === "kanban-card" || data?.type === "kanban-column")
        );
      },
      onDrag: ({ location }) => {
        const viewport = scrollViewportRef.current;
        if (!viewport) return;
        const { bottom, left, right, top, width } =
          viewport.getBoundingClientRect();
        const pointerX = location.current.input.clientX;
        const pointerY = location.current.input.clientY;
        const edgeZone = width * 0.1;
        autoScrollDirectionRef.current =
          pointerY < top ||
          pointerY > bottom ||
          pointerX < left ||
          pointerX > right
            ? 0
            : pointerX < left + edgeZone
              ? -1
              : pointerX > right - edgeZone
                ? 1
                : 0;
        if (
          autoScrollDirectionRef.current !== 0 &&
          autoScrollFrameRef.current === undefined
        ) {
          autoScrollFrameRef.current =
            window.requestAnimationFrame(scrollFrame);
        }
      },
      onDrop: stopAutoScroll,
    });
    const handleEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") stopAutoScroll();
    };
    window.addEventListener("keydown", handleEscape);
    return () => {
      stopAutoScroll();
      cleanupMonitor();
      window.removeEventListener("keydown", handleEscape);
    };
  }, [readonly]);

  useEffect(() => {
    // An adapter's new explicit request wins; later accepted moves can then
    // restore the remounted card without re-consuming that adapter request.
    const request =
      focusRequest !== handledFocusRequestRef.current
        ? focusRequest
        : moveFocusRequest;
    handledFocusRequestRef.current = focusRequest;
    if (!request) return;
    let frame: number | undefined;
    let attempts = 0;
    const focus = () => {
      const { selection } = request;
      const id = selection?.cardId ?? selection?.columnId;
      const attribute = selection?.cardId ? "data-card-id" : "data-column-id";
      const target =
        request.target === "board"
          ? boardRef.current
          : request.target === "add-column-empty"
            ? boardRef.current?.querySelector<HTMLElement>(
                '[data-myoxus-kanban-focus="add-column-empty"]',
              )
            : id
              ? boardRef.current?.querySelector<HTMLElement>(
                  `[${attribute}="${CSS.escape(id)}"]`,
                )
              : null;
      const focusTarget =
        request.target === "card-title"
          ? target?.querySelector<HTMLElement>(
              '[data-myoxus-ui-role="inline-edit-display"]',
            )
          : target;
      if (focusTarget) {
        selectionTargetChangeRef.current?.(focusTarget);
        focusTarget.focus();
        return;
      }
      attempts += 1;
      if (attempts < 12) frame = window.requestAnimationFrame(focus);
    };
    frame = window.requestAnimationFrame(focus);
    return () => {
      if (frame !== undefined) window.cancelAnimationFrame(frame);
    };
  }, [focusRequest, moveFocusRequest]);

  useEffect(() => {
    const id = selection?.cardId ?? selection?.columnId;
    if (!id || !onSelectionTargetChange) return;
    const attribute = selection?.cardId ? "data-card-id" : "data-column-id";
    const frame = window.requestAnimationFrame(() => {
      const target = boardRef.current?.querySelector<HTMLElement>(
        `[${attribute}="${CSS.escape(id)}"]`,
      );
      if (target) onSelectionTargetChange(target);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [columns, onSelectionTargetChange, selection]);

  const handleHorizontalWheel = useCallback((event: WheelEvent) => {
    const horizontalDelta = event.shiftKey
      ? event.deltaY
      : Math.abs(event.deltaX) > Math.abs(event.deltaY)
        ? event.deltaX
        : 0;
    if (!horizontalDelta) return;
    event.preventDefault();
    scrollViewportRef.current?.scrollBy({ left: horizontalDelta });
  }, []);
  useEffect(() => {
    const board = boardRef.current;
    if (!board) return;
    // React's delegated wheel listener is passive. Consume horizontal intent once
    // at this board, while ordinary vertical scrolling and chaining remain native.
    board.addEventListener("wheel", handleHorizontalWheel, { passive: false });
    return () => board.removeEventListener("wheel", handleHorizontalWheel);
  }, [handleHorizontalWheel]);
  return (
    <Stack
      ref={boardRef}
      aria-label={ariaLabel}
      data-myoxus-ui-role="kanban-board"
      data-appearance={appearance}
      data-testid={dataTestId}
      role="region"
      tabIndex={-1}
      gap="xs"
    >
      {toolbar}
      {error ? (
        <Box data-myoxus-ui-role="kanban-error" role="alert">
          {error}
        </Box>
      ) : null}
      {columns.length === 0 ? (
        <Stack align="flex-start" data-myoxus-ui-role="kanban-empty">
          {empty}
          {canAddColumn ? (
            <Button
              variant="subtle"
              leftSection={<PlusIcon />}
              aria-label={labels.addColumn}
              data-myoxus-kanban-focus="add-column-empty"
              onClick={(event) => void onAddColumn?.(event.currentTarget)}
            >
              {labels.addColumn}
            </Button>
          ) : null}
        </Stack>
      ) : null}
      {columns.length > 0 ? (
        <PrimaryScrollArea
          data-myoxus-ui-role="kanban-board-scroll-root"
          offsetScrollbars={appearance === "surface" ? false : "x"}
          scrollbars={appearance === "surface" ? "x" : "xy"}
          owner={scrollOwner}
          autosize={appearance !== "surface" && scrollOwner === "self"}
          // As in the time workarea, native Autosize bounds the owned
          // renderer plane; tall columns share this one vertical/horizontal owner.
          mah={
            appearance !== "surface" && scrollOwner === "self"
              ? "70vh"
              : undefined
          }
          type="auto"
          viewportRef={scrollViewportRef}
        >
          <Group align="stretch" gap="md" wrap="nowrap" w="max-content">
            <Group
              component="ul"
              align="stretch"
              gap="md"
              wrap="nowrap"
              role="list"
              data-myoxus-ui-role="kanban-column-list"
            >
              {orderedColumns.map((column, index) => (
                <KanbanColumn
                  key={column.id}
                  column={column}
                  boardId={boardId}
                  columnIndex={index}
                  columns={orderedColumns}
                  labels={labels}
                  renderLabel={renderLabel}
                  readonly={readonly}
                  appearance={appearance}
                  activation={activation}
                  order={order}
                  keyboardMovement={keyboardMovement}
                  selection={selection}
                  editRequest={editRequest}
                  onAddCard={onAddCard}
                  onInteractionStart={onInteractionStart}
                  onEditEnd={onEditEnd}
                  onOpenColumn={onOpenColumn}
                  onMoveCard={onMoveCard ? moveCard : undefined}
                  onMoveColumn={onMoveColumn}
                  onOpenCard={onOpenCard}
                  onSelectCard={onSelectCard}
                  onSelectColumn={onSelectColumn}
                  onDeleteCard={onDeleteCard}
                  onDeleteColumn={onDeleteColumn}
                  onRenameCard={onRenameCard}
                  onRenameColumn={onRenameColumn}
                  keyboardCardDrag={keyboardCardDrag}
                  keyboardColumnDrag={keyboardColumnDrag}
                  onKeyboardCardDragChange={changeKeyboardCardDrag}
                  onKeyboardColumnDragChange={changeKeyboardColumnDrag}
                  announce={announce}
                />
              ))}
            </Group>
            {canAddColumn ? (
              <Box data-myoxus-ui-role="kanban-add-column">
                {appearance === "surface" ? (
                  <SurfaceButton
                    variant="ghost"
                    prefix={<PlusIcon />}
                    aria-label={labels.addColumn}
                    data-myoxus-kanban-focus="add-column"
                    onClick={(event) => void onAddColumn?.(event.currentTarget)}
                  >
                    {labels.addColumn}
                  </SurfaceButton>
                ) : (
                  <Button
                    variant="subtle"
                    leftSection={<PlusIcon />}
                    aria-label={labels.addColumn}
                    data-myoxus-kanban-focus="add-column"
                    onClick={(event) => void onAddColumn?.(event.currentTarget)}
                  >
                    {labels.addColumn}
                  </Button>
                )}
              </Box>
            ) : null}
          </Group>
        </PrimaryScrollArea>
      ) : null}
      <VisuallyHidden aria-live="polite">
        <span key={announcement.sequence}>{announcement.message}</span>
      </VisuallyHidden>
    </Stack>
  );
}
