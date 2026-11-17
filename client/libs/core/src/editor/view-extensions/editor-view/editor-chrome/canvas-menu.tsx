// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import {
  ColorPicker,
  Divider,
  Group,
  Slider,
  Stack,
  ToolbarSurface,
} from "@myoxus/ui-facade";
import type { EditorCanvasMenuControls } from "@virgultum/editor/shared/services";
import { Fragment, type KeyboardEvent } from "react";
import { EditorCanvasTool } from "./canvas-toolbar";
import {
  ActionButton,
  SelectionActions,
} from "./selection-toolbar/block-actions";
import { renderControl } from "./selection-toolbar";

/** A native presentation of existing actions; canvas tools retain their commands. */
export function EditorCanvasMenu({
  controls,
}: {
  controls: EditorCanvasMenuControls;
}) {
  if (
    controls.actions.some(
      (action) =>
        action.id === "presentation-dark-background" ||
        action.id === "presentation-hide-toolbar",
    )
  ) {
    return (
      <ToolbarSurface compact justify="flex-start" role="toolbar">
        <Stack
          onKeyDown={preservePresentationCheckboxKey}
          onKeyUp={preservePresentationCheckboxKey}
        >
          {controls.actions.map((action) =>
            action.control ? (
              <SelectionActions
                key={action.id}
                actions={[action]}
                menu
                renderControl={renderControl}
              />
            ) : (
              <ActionButton key={action.id} action={action} />
            ),
          )}
        </Stack>
      </ToolbarSurface>
    );
  }
  return (
    <ToolbarSurface compact justify="flex-start" role="toolbar">
      {controls.tools?.map((tool) => (
        <Fragment key={tool.action.id}>
          {tool.separatorBefore && <Divider orientation="vertical" />}
          <EditorCanvasTool {...tool} />
        </Fragment>
      ))}
      {controls.tools?.length && controls.actions.length ? (
        <Divider orientation="vertical" />
      ) : null}
      {controls.actions.map((action, index) => {
        const control = action.control;
        return (
          <Fragment key={action.id}>
            {index > 0 && <Divider orientation="vertical" />}
            {control?.type === "color" ? (
              <Group wrap="nowrap" gap="xs">
                <ColorPicker
                  value={control.value}
                  format="hexa"
                  withPicker={false}
                  swatches={control.swatches ? [...control.swatches] : []}
                  swatchesPerRow={control.swatches?.length || 1}
                  onChange={control.change}
                  aria-label={action.label}
                />
              </Group>
            ) : control?.type === "number" && control.presets?.length ? (
              <Slider
                value={Number(control.value)}
                min={control.presets[0]}
                max={control.presets.at(-1)}
                nodes={[...control.presets]}
                restrictToMarks
                // Preserve one hit position per existing discrete width; labels stay in native tooltips.
                style={{
                  width: `calc(${control.presets.length} * var(--mantine-spacing-lg))`,
                }}
                onChange={control.change}
                aria-label={action.label}
                disabled={action.disabled}
              />
            ) : action.actions || control ? (
              <SelectionActions
                actions={[action]}
                renderControl={renderControl}
              />
            ) : (
              <ActionButton action={action} />
            )}
          </Fragment>
        );
      })}
    </ToolbarSurface>
  );
}

function preservePresentationCheckboxKey(event: KeyboardEvent<HTMLDivElement>) {
  // Space belongs to this focused checkbox, not the canvas pan shortcut.
  if (
    event.key === " " &&
    !event.nativeEvent.isComposing &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey &&
    event.target instanceof HTMLInputElement &&
    event.target.type === "checkbox"
  )
    event.stopPropagation();
}
