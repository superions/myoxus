// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
import { useI18n } from "@myoxus/i18n";
import { Textarea } from "@myoxus/ui-facade";
import type { EditorBlockCaptionControls } from "@virgultum/editor/shared/services";
import { useLayoutEffect, useRef, useSyncExternalStore } from "react";

export function EditorBlockCaption({
  controls,
}: {
  controls: EditorBlockCaptionControls;
}) {
  const t = useI18n();
  const value = useSyncExternalStore(controls.subscribe, controls.getSnapshot);
  const input = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    if (controls.focusRequest) input.current?.focus();
  }, [controls.focusRequest]);
  const label = t["com.myoxus.editor.caption.placeholder"]();
  return (
    <Textarea
      ref={input}
      data-range-sync-exclude="true"
      aria-label={label}
      placeholder={label}
      value={value}
      readOnly={controls.readonly}
      onChange={controls.change}
      onFocus={() => controls.setFocused(true)}
      onBlur={() => controls.setFocused(false)}
      autosize
      presentation="caption"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onCopy={(e) => e.stopPropagation()}
      onCut={(e) => e.stopPropagation()}
      onPaste={(e) => e.stopPropagation()}
      onKeyUp={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (
          e.key === "Enter" &&
          !e.nativeEvent.isComposing &&
          controls.enter(e.currentTarget)
        )
          e.preventDefault();
      }}
    />
  );
}
