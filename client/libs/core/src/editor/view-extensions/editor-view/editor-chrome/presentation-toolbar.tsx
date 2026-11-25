// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Button, Divider, Group, MyoxusText } from "@myoxus/ui-facade";
import type { EditorPresentationToolbarControls } from "@virgultum/editor/shared/services";

import { EditorCanvasPopover } from "./canvas-popover";
import { EditorCanvasTool } from "./canvas-toolbar";

/** Accessible presentation navigator rendered natively via Mantine ToolbarSurface children. */
export function EditorPresentationToolbar({
  controls,
}: {
  controls: EditorPresentationToolbarControls;
}) {
  return (
    <Group wrap="nowrap" gap="xs" align="center">
      <EditorCanvasTool {...controls.previous} />
      <Button
        variant="plain"
        size="compact-sm"
        onClick={controls.focusCurrentFrame}
        data-testid="presentation-frame-title"
      >
        <Group wrap="nowrap" gap="xs" align="center">
          <MyoxusText
            component="span"
            typographySlot="body-small"
            truncate
            maw={140}
          >
            {controls.title}
          </MyoxusText>
          <MyoxusText
            component="span"
            tone="secondary"
            typographySlot="dense-label"
          >
            {controls.count}
          </MyoxusText>
        </Group>
      </Button>
      <EditorCanvasTool {...controls.next} />
      <Divider orientation="vertical" />
      <Group wrap="nowrap" gap="xs" align="center">
        <EditorCanvasTool {...controls.fullscreen} />
        {controls.frameOrder ? (
          <EditorCanvasPopover controls={controls.frameOrder} />
        ) : null}
        <EditorCanvasPopover controls={controls.settings} />
      </Group>
      <Divider orientation="vertical" />
      <EditorCanvasTool {...controls.stop} />
    </Group>
  );
}
