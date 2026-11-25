// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  Box,
  Popover,
  PopoverContent,
  PopoverTarget,
  Stack,
} from "@myoxus/ui-facade";
import type { EditorCanvasPopoverControls } from "@virgultum/editor/shared/services";
import { useEffect, useRef } from "react";

import { EditorCanvasMenu } from "./canvas-menu";
import { EditorCanvasTemplates } from "./canvas-templates";
import { EditorCanvasTool } from "./canvas-toolbar";
import { EditorFrameOrder } from "./frame-order";

function NativePopoverBody({
  mount,
}: {
  mount: (host: HTMLElement) => (() => void) | void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const cleanup = mount(el);
    return () => {
      cleanup?.();
      el.replaceChildren();
    };
  }, [mount]);
  return <Box ref={ref} />;
}

/** Mantine Popover host for canvas dock submenus, template catalog, and presentation/frame menus. */
export function EditorCanvasPopover({
  controls,
}: {
  controls: EditorCanvasPopoverControls;
}) {
  const {
    opened,
    onClose,
    position = "top",
    offset,
    withArrow = false,
    closeOnClickOutside = true,
    label,
    trigger,
    content,
  } = controls;

  const flushSurface = !withArrow;

  return (
    <Popover
      opened={opened}
      onChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
      position={position}
      offset={offset}
      withArrow={withArrow}
      floatingStrategy="fixed"
      closeOnEscape
      closeOnClickOutside={closeOnClickOutside}
      returnFocus={Boolean(trigger && closeOnClickOutside)}
    >
      <PopoverTarget>
        {trigger ? (
          <Box component="span" style={{ display: "inline-flex" }}>
            <EditorCanvasTool {...trigger} />
          </Box>
        ) : (
          <Box
            component="span"
            aria-hidden
            style={{
              position: "absolute",
              inset: 0,
              pointerEvents: "none",
            }}
          />
        )}
      </PopoverTarget>
      <PopoverContent
        role="dialog"
        aria-label={label}
        data-range-sync-exclude="true"
        style={
          flushSurface
            ? {
                padding: 0,
                border: "none",
                background: "transparent",
                boxShadow: "none",
              }
            : { padding: 0 }
        }
        onPointerDown={(event) => event.stopPropagation()}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          }
        }}
      >
        {content.kind === "menu" ? (
          <EditorCanvasMenu controls={content.controls} />
        ) : content.kind === "frame-order" ? (
          <EditorFrameOrder controls={content.controls} />
        ) : content.kind === "templates" ? (
          <EditorCanvasTemplates controls={content.controls} />
        ) : content.kind === "menu-with-frame-order" ? (
          <Stack gap="xs">
            <EditorCanvasMenu controls={content.menu} />
            <EditorFrameOrder controls={content.frameOrder} />
          </Stack>
        ) : (
          <NativePopoverBody mount={content.mount} />
        )}
      </PopoverContent>
    </Popover>
  );
}
