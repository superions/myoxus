// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { CodeIcon } from "@myoxus/icons/react";
import {
  Box,
  Card,
  EmptyState,
  Group,
  MyoxusText,
  Stack,
} from "@myoxus/ui-facade";
import type { EditorHtmlEmbedControls } from "@virgultum/editor/shared/services";
import { useEffect, useRef } from "react";

/** Native Mantine card framing an HTML embed block's live sandboxed iframe. */
export function EditorHtmlEmbedCard({
  controls,
}: {
  controls: EditorHtmlEmbedControls;
}) {
  const frameRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = frameRef.current;
    if (!el || controls.empty) return;
    const cleanup = controls.mountFrame(el);
    return () => {
      cleanup?.();
      el.replaceChildren();
    };
  }, [controls.empty, controls.mountFrame]);

  if (controls.empty) {
    return (
      <Card withBorder padding="sm">
        <EmptyState title={controls.emptyLabel} />
      </Card>
    );
  }

  return (
    <Card
      withBorder
      padding="sm"
      style={{ height: "100%" }}
      data-selected={controls.selected ? "true" : undefined}
      onClick={(event) => controls.select(event.nativeEvent)}
      onDoubleClick={(event) => controls.open(event.nativeEvent)}
    >
      <Stack gap="md" h="100%">
        <Box
          ref={frameRef}
          flex={1}
          mih={0}
          w="100%"
          className="myoxus-embed-html-iframe-container"
        />
        <Group gap="xs" wrap="nowrap" align="center">
          <CodeIcon />
          <MyoxusText component="span" typographySlot="body-small" truncate>
            {controls.title}
          </MyoxusText>
        </Group>
      </Stack>
    </Card>
  );
}
