// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { useI18n } from "@myoxus/i18n";
import type { KeyboardEvent } from "react";
import {
  ArrowLeftSmallIcon,
  ArrowRightSmallIcon,
  InvisibleIcon,
} from "@myoxus/icons/react";
import {
  Button,
  IconButton,
  Menu,
  MenuItem,
  ToolbarSurface,
  Text,
  Tooltip,
} from "@myoxus/ui-facade";
import type {
  EditorAutoCompleteTriggerControls,
  EditorAutoCompletePanelControls,
  EditorAutoConnectLabelControls,
  EditorAutoConnectNavigatorControls,
} from "@virgultum/editor/shared/services";
import { editorGlyph } from "./glyphs";

function stopCanvasKey(event: KeyboardEvent) {
  if (event.key !== "Tab") event.stopPropagation();
}

export function EditorAutoCompleteTrigger({
  controls,
}: {
  controls: EditorAutoCompleteTriggerControls;
}) {
  return (
    <IconButton
      tooltip={controls.label}
      aria-label={controls.label}
      data-range-sync-exclude="true"
      onPointerDown={(event) => {
        event.stopPropagation();
        if (event.button === 0) controls.pointerDown(event.nativeEvent);
      }}
      // Pointer gestures finish in the controller; a native keyboard click has no pointer session.
      onClick={(event) => {
        event.stopPropagation();
        if (event.detail === 0) controls.activate();
      }}
      onKeyDown={stopCanvasKey}
      onMouseEnter={() => controls.preview(true)}
      onMouseLeave={() => controls.preview(false)}
      onFocus={() => controls.preview(true)}
      onBlur={() => controls.preview(false)}
    >
      {editorGlyph(controls.icon)}
    </IconButton>
  );
}

export function EditorAutoCompletePanel({
  controls,
}: {
  controls: EditorAutoCompletePanelControls;
}) {
  return (
    <Menu
      noPortal
      rootOptions={{
        open: true,
        onClose: controls.close,
        clickOutsideEvents: ["pointerdown"],
        closeOnItemClick: false,
      }}
      contentOptions={{
        side: "bottom",
        align: "start",
        "aria-label": controls.label,
        "data-range-sync-exclude": "true",
        onPointerDown: (event) => event.stopPropagation(),
        onClick: (event) => event.stopPropagation(),
        onKeyDown: stopCanvasKey,
      }}
      items={controls.options.map((option, index) => (
        <MenuItem
          key={index}
          prefixIcon={editorGlyph(option.icon)}
          onMouseEnter={() => option.preview(true)}
          onMouseLeave={() => option.preview(false)}
          onFocus={() => option.preview(true)}
          onBlur={() => option.preview(false)}
          onSelect={option.choose}
        >
          {option.label}
        </MenuItem>
      ))}
    >
      <span aria-hidden ref={controls.setAnchor} />
    </Menu>
  );
}

export function EditorAutoConnectLabel({
  controls,
}: {
  controls: EditorAutoConnectLabelControls;
}) {
  const t = useI18n();
  const label =
    controls.index === undefined
      ? t["com.myoxus.editor.canvas.hidden-on-page"]()
      : t["com.myoxus.editor.canvas.page-index"]({
          index: new Intl.NumberFormat(t.language).format(controls.index),
        });
  return controls.index === undefined ? (
    <Tooltip content={label}>
      <Text component="span" role="img" aria-label={label}>
        <InvisibleIcon />
      </Text>
    </Tooltip>
  ) : (
    <Tooltip content={label}>
      <Button
        aria-label={label}
        aria-pressed={controls.active}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          controls.toggle();
        }}
        onKeyDown={stopCanvasKey}
      >
        {new Intl.NumberFormat(t.language).format(controls.index)}
      </Button>
    </Tooltip>
  );
}

export function EditorAutoConnectNavigator({
  controls,
}: {
  controls: EditorAutoConnectNavigatorControls;
}) {
  const t = useI18n();
  return (
    <ToolbarSurface
      compact
      role="group"
      data-range-sync-exclude="true"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={stopCanvasKey}
    >
      <IconButton
        icon={<ArrowLeftSmallIcon />}
        tooltip={t["common.previous"]()}
        disabled={!controls.previous}
        onClick={() => controls.navigate(-1)}
      />
      <IconButton
        icon={<ArrowRightSmallIcon />}
        tooltip={t["common.next"]()}
        disabled={!controls.next}
        onClick={() => controls.navigate(1)}
      />
    </ToolbarSurface>
  );
}
