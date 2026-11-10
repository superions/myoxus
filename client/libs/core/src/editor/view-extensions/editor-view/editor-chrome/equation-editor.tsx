// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { useI18n } from "@myoxus/i18n";
import { DoneIcon } from "@myoxus/icons/react";
import { Group, IconButton, InputBase, Scrollable } from "@myoxus/ui-facade";
import type { EditorEquationControls } from "@virgultum/editor/shared/services";
import { flushSync } from "react-dom";
import { EditorInlinePopup } from "./inline-popup";

export function EditorEquation({
  controls,
}: {
  controls: EditorEquationControls;
}) {
  const t = useI18n();
  const label = t["com.myoxus.editor.slash.equation"]();
  const close = () => {
    // Unmount the input before the next keystroke can reach the document caret.
    flushSync(controls.close);
    controls.restoreFocus();
  };
  return (
    <EditorInlinePopup
      controls={{ ...controls, close }}
      label={label}
      onSubmit={close}
      contentMeasure="reading"
      position={controls.position}
    >
      <Group wrap="nowrap">
        <Scrollable.Viewport autosize maxHeight="floating" data-equation-scroll>
          <InputBase
            component="div"
            multiline
            size="md"
            styles={{
              input: { fontFamily: "var(--mantine-font-family-monospace)" },
            }}
            ref={controls.mountSource}
            aria-label={label}
            onCopyCapture={controls.syncSourceRange}
            onCutCapture={controls.syncSourceRange}
            onPasteCapture={controls.syncSourceRange}
            onKeyDown={(event) => {
              // Let the source editor finish IME composition without the outer form intercepting Enter.
              if (event.nativeEvent.isComposing) {
                event.stopPropagation();
                return;
              }
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                close();
              }
            }}
          />
        </Scrollable.Viewport>
        <IconButton
          aria-label={t["Confirm"]()}
          tooltip={`${t["Confirm"]()} · ${t["com.myoxus.editor.equation.line-break-hint"]()}`}
          tooltipShortcut={["Enter"]}
          onClick={close}
        >
          <DoneIcon />
        </IconButton>
      </Group>
    </EditorInlinePopup>
  );
}
