// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import {
  Box,
  DragHandle,
  DropIndicator,
  NavLink,
  Scrollable,
  Stack,
  ToolbarSurface,
} from "@myoxus/ui-facade";
import type { EditorFrameOrderControls } from "@virgultum/editor/shared/services";
import { useRef, useState, type DragEvent } from "react";

/** Native drag preview and shared drop indicator replace the old cloned Lit row. */
export function EditorFrameOrder({
  controls: c,
}: {
  controls: EditorFrameOrderControls;
}) {
  const source = useRef<string | null>(null);
  const [drop, setDrop] = useState<{
    id: string;
    edge: "top" | "bottom";
  } | null>(null);
  const clear = () => {
    source.current = null;
    setDrop(null);
  };
  const list = (
    <Scrollable.Root
      onClick={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
    >
      <Scrollable.Viewport autosize maxHeight="selector">
        <Stack gap={0} data-testid="presentation-frame-order-list">
          {c.items.map((item, index) => (
            <Box
              key={item.id}
              pos="relative"
              onDragOver={(event: DragEvent<HTMLElement>) => {
                if (!source.current || c.readonly) return;
                event.preventDefault();
                event.stopPropagation();
                event.dataTransfer.dropEffect = "move";
                const rect = event.currentTarget.getBoundingClientRect();
                setDrop({
                  id: item.id,
                  edge:
                    event.clientY < rect.top + rect.height / 2
                      ? "top"
                      : "bottom",
                });
              }}
              onDrop={(event: DragEvent<HTMLElement>) => {
                event.preventDefault();
                event.stopPropagation();
                if (source.current && drop?.id === item.id && !c.readonly) {
                  c.move(
                    source.current,
                    drop.edge === "top"
                      ? item.id
                      : (c.items[index + 1]?.id ?? null),
                  );
                }
                clear();
              }}
            >
              <NavLink
                component="div"
                label={item.title}
                title={item.title}
                leftSection={<DragHandle />}
                draggable={!c.readonly}
                data-frame-order-id={item.id}
                onPointerDown={(event) => event.stopPropagation()}
                onDragStart={(event: DragEvent<HTMLElement>) => {
                  if (c.readonly) {
                    event.preventDefault();
                    return;
                  }
                  source.current = item.id;
                  event.dataTransfer.effectAllowed = "move";
                  event.dataTransfer.setData(
                    "application/x-myoxus-presentation-frame",
                    item.id,
                  );
                  event.stopPropagation();
                }}
                onDragEnd={clear}
              />
              {drop?.id === item.id ? <DropIndicator edge={drop.edge} /> : null}
            </Box>
          ))}
        </Stack>
      </Scrollable.Viewport>
    </Scrollable.Root>
  );
  return c.embedded ? (
    list
  ) : (
    <ToolbarSurface compact justify="flex-start">
      {list}
    </ToolbarSurface>
  );
}
