// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { getArtworkUrl } from "@myoxus/theme/artwork";
import {
  Box,
  EmptyState,
  Group,
  MyoxusText,
  ReferenceCard,
  RowInput,
  Stack,
} from "@myoxus/ui-facade";
import type {
  FrameNavigatorController,
  FrameNavigatorItem,
} from "@virgultum/editor/fragments/frame-panel";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type MouseEvent as ReactMouseEvent,
} from "react";

const DRAG_THRESHOLD_PX = 5;

function FramePreviewSlot({
  controller,
  frameId,
}: {
  controller: FrameNavigatorController;
  frameId: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    return controller.mountPreview(container, frameId);
  }, [controller, frameId]);

  return <Box ref={containerRef} />;
}

function FrameNavigatorCard({
  controller,
  item,
  readonly,
  dragging,
  onStartDrag,
}: {
  controller: FrameNavigatorController;
  item: FrameNavigatorItem;
  readonly: boolean;
  dragging: boolean;
  onStartDrag: (
    event: ReactMouseEvent<HTMLDivElement>,
    frameId: string,
  ) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.title);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) setDraft(item.title);
  }, [editing, item.title]);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const commitRename = useCallback(() => {
    setEditing(false);
    controller.renameFrame(item.id, draft);
  }, [controller, draft, item.id]);

  return (
    <Box
      data-frame-id={item.id}
      style={dragging && item.selected ? { opacity: 0.5 } : undefined}
    >
      <ReferenceCard
        size="preview"
        contained
        selected={item.selected}
        data-testid="frame-navigator-card"
        title={
          <Group
            wrap="nowrap"
            onClick={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
          >
            <MyoxusText
              component="span"
              typographySlot="dense-label"
              tone="secondary"
            >
              {item.index + 1}
            </MyoxusText>
            {editing ? (
              <RowInput
                ref={inputRef}
                value={draft}
                onChange={(value) => setDraft(value)}
                onBlur={commitRename}
                onKeyDown={(event) => {
                  event.stopPropagation();
                  if (event.nativeEvent.isComposing) return;
                  if (event.key === "Enter") {
                    event.preventDefault();
                    commitRename();
                  } else if (event.key === "Escape") {
                    event.preventDefault();
                    setDraft(item.title);
                    setEditing(false);
                  }
                }}
              />
            ) : (
              <Box
                component="span"
                flex={1}
                miw={0}
                onDoubleClick={(event) => {
                  event.stopPropagation();
                  if (!readonly) setEditing(true);
                }}
              >
                <MyoxusText
                  component="span"
                  truncate
                  typographySlot="body-small"
                >
                  {item.title}
                </MyoxusText>
              </Box>
            )}
          </Group>
        }
      >
        <Box
          pos="relative"
          onClick={(event) => {
            event.stopPropagation();
            controller.select(item.id, event.shiftKey);
          }}
          onDoubleClick={(event) => {
            event.stopPropagation();
            controller.fitFrame(item.id);
          }}
          onMouseDown={(event) => onStartDrag(event, item.id)}
        >
          <FramePreviewSlot controller={controller} frameId={item.id} />
        </Box>
      </ReferenceCard>
    </Box>
  );
}

/**
 * Mantine-through-Facade frame navigator consuming {@link FrameNavigatorController}
 * directly without intermediate custom elements.
 */
export function EditorFrameNavigator({
  controller,
  emptyLabel,
}: {
  controller: FrameNavigatorController;
  emptyLabel: string;
}) {
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
  );
  const listRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const [indicatorY, setIndicatorY] = useState<number | undefined>(undefined);

  const handleStartDrag = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>, frameId: string) => {
      if (event.button !== 0 || state.readonly) return;
      event.preventDefault();

      const ownerDoc = event.currentTarget.ownerDocument;
      const startX = event.clientX;
      const startY = event.clientY;
      let active = false;
      let dropIndex: number | undefined;

      const onMouseMove = (moveEvent: MouseEvent) => {
        if (!active) {
          if (
            Math.abs(moveEvent.clientX - startX) < DRAG_THRESHOLD_PX &&
            Math.abs(moveEvent.clientY - startY) < DRAG_THRESHOLD_PX
          ) {
            return;
          }
          active = true;
          setDragging(true);
          if (!controller.getSnapshot().selectedIds.includes(frameId)) {
            controller.select(frameId, false);
          }
        }

        const listEl = listRef.current;
        if (!listEl) return;
        const listRect = listEl.getBoundingClientRect();
        if (
          moveEvent.clientX < listRect.left ||
          moveEvent.clientX > listRect.right ||
          moveEvent.clientY < listRect.top ||
          moveEvent.clientY > listRect.bottom
        ) {
          dropIndex = undefined;
          setIndicatorY(undefined);
          return;
        }

        const cards = Array.from(
          listEl.querySelectorAll<HTMLElement>("[data-frame-id]"),
        );
        let targetIndex = cards.length;
        let targetY = listEl.scrollHeight;
        for (let i = 0; i < cards.length; i++) {
          const rect = cards[i].getBoundingClientRect();
          const midY = rect.top + rect.height / 2;
          if (moveEvent.clientY <= midY) {
            targetIndex = i;
            targetY = cards[i].offsetTop;
            break;
          }
          targetY = cards[i].offsetTop + cards[i].offsetHeight;
        }
        dropIndex = targetIndex;
        setIndicatorY(targetY);
      };

      const onMouseUp = () => {
        ownerDoc.removeEventListener("mousemove", onMouseMove);
        ownerDoc.removeEventListener("mouseup", onMouseUp);
        if (active) {
          const selected = controller.getSnapshot().selectedIds;
          setDragging(false);
          setIndicatorY(undefined);
          if (dropIndex !== undefined) {
            controller.reorderFrames(selected, dropIndex);
          }
        }
      };

      ownerDoc.addEventListener("mousemove", onMouseMove);
      ownerDoc.addEventListener("mouseup", onMouseUp);
    },
    [controller, state.readonly],
  );

  if (state.frames.length === 0) {
    return (
      <EmptyState
        title={emptyLabel}
        media={
          <Box
            component="img"
            src={getArtworkUrl("presentation")}
            alt=""
            w="100%"
          />
        }
        data-testid="frame-navigator-empty"
      />
    );
  }

  return (
    <Stack
      ref={listRef}
      pos="relative"
      data-testid="frame-navigator-list"
      onClick={(event) => {
        if (
          !(event.target as HTMLElement).closest(
            '[data-testid="frame-navigator-card"]',
          )
        ) {
          controller.clearSelection();
        }
      }}
    >
      {state.frames.map((item) => (
        <FrameNavigatorCard
          key={item.id}
          controller={controller}
          item={item}
          readonly={state.readonly}
          dragging={dragging}
          onStartDrag={handleStartDrag}
        />
      ))}
      {indicatorY !== undefined ? (
        <Box
          pos="absolute"
          left={0}
          right={0}
          h={2}
          bg="myoxus"
          style={{ transform: `translateY(${indicatorY}px)` }}
          data-testid="frame-insert-indicator"
        />
      ) : null}
    </Stack>
  );
}
