// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { FigmaDuotoneIcon, OpenInNewIcon } from "@myoxus/icons/react";
import { Box, Group, MyoxusText, ReferenceCard } from "@myoxus/ui-facade";
import type { EditorFigmaCardControls } from "@virgultum/editor/shared/services";

/** The existing iframe/security contract and block commands stay with the editor. */
export function EditorFigmaCard({
  controls: c,
}: {
  controls: EditorFigmaCardControls;
}) {
  return (
    <ReferenceCard
      size="preview"
      orientation="vertical"
      contained
      fullHeight
      selected={c.selected}
      title={c.title}
      description={c.description || undefined}
      icon={<FigmaDuotoneIcon />}
      preview={
        <Box pos="relative" h="100%">
          <Box
            component="iframe"
            src={c.iframeUrl}
            title={c.title}
            sandbox="allow-same-origin allow-scripts allow-presentation"
            allow="fullscreen"
            loading="lazy"
            // Apply this boolean browser attribute before insertion, as in the original iframe.
            {...{ credentialless: true }}
            display="block"
            w="100%"
            h="100%"
            // Renderer geometry: suppress the browser's intrinsic iframe border.
            style={{ border: 0 }}
          />
          <Box
            pos="absolute"
            inset={0}
            hidden={!c.showOverlay}
            data-testid="figma-iframe-guard"
          />
        </Box>
      }
      footer={
        <Group gap="xs" wrap="nowrap" onClick={c.open}>
          <MyoxusText
            typographySlot="dense-label"
            tone={c.selected ? "link" : "secondary"}
            truncate
            title={c.url}
          >
            www.figma.com
          </MyoxusText>
          <OpenInNewIcon />
        </Group>
      }
      onClick={(event) => c.select(event.nativeEvent)}
      onDoubleClick={(event) => {
        event.stopPropagation();
        c.open();
      }}
      data-testid="editor-figma-card"
    />
  );
}
