// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { Box, Popover, PopoverContent, PopoverTarget } from "@myoxus/ui-facade";
import type { ComponentProps } from "react";
import type { EditorInlinePopupControls } from "@virgultum/editor/shared/services";
import type { PropsWithChildren } from "react";

/** Shared overlay lifetime and editor-event isolation, without a second layout system. */
export function EditorInlinePopup({
  controls,
  label,
  onSubmit,
  position = "bottom-start",
  contentMeasure,
  children,
}: PropsWithChildren<{
  controls: EditorInlinePopupControls;
  label: string;
  onSubmit: () => void;
  position?: ComponentProps<typeof Popover>["position"];
  contentMeasure?: ComponentProps<typeof Popover>["contentMeasure"];
}>) {
  return (
    <Popover
      opened
      onChange={(open) => {
        if (!open) controls.close();
      }}
      position={position}
      contentMeasure={contentMeasure}
      floatingStrategy="fixed"
      fitViewport
      trapFocus
      returnFocus={false}
      closeOnEscape={false}
    >
      <PopoverTarget>
        <span aria-hidden ref={controls.setAnchor} />
      </PopoverTarget>
      <PopoverContent
        role="dialog"
        aria-label={label}
        data-range-sync-exclude="true"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          // Mantine's native focus trap handles Tab at the document boundary.
          if (event.key !== "Tab") event.stopPropagation();
          if (event.nativeEvent.isComposing) {
            if (event.key === "Enter") event.preventDefault();
            return;
          }
          if (event.key === "Escape") {
            event.preventDefault();
            controls.close();
          }
        }}
      >
        <Box
          component="form"
          onCopy={(event) => event.stopPropagation()}
          onCut={(event) => event.stopPropagation()}
          onPaste={(event) => event.stopPropagation()}
          onSubmit={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onSubmit();
          }}
        >
          {children}
        </Box>
      </PopoverContent>
    </Popover>
  );
}
