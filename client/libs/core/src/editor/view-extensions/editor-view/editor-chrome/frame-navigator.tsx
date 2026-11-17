// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { getArtworkUrl } from "@myoxus/theme/artwork";
import {
  Badge,
  Box,
  EmptyState,
  Group,
  MyoxusText,
  ReferenceCard,
  Stack,
} from "@myoxus/ui-facade";
import type {
  EditorFrameCardControls,
  EditorFrameNavigatorControls,
  EditorFrameTitleControls,
} from "@virgultum/editor/shared/services";
import { createElement } from "react";

export function EditorFrameNavigator({
  controls: c,
}: {
  controls: EditorFrameNavigatorControls;
}) {
  if (!c.items.length) {
    return (
      <EmptyState
        title={c.emptyLabel}
        media={
          <Box
            component="img"
            src={getArtworkUrl("presentation")}
            alt=""
            w="100%"
          />
        }
        data-testid="frame-navigator-empty"
      />
    );
  }
  return (
    // Existing drag hit-testing uses direct card children and this offset parent.
    <Stack ref={c.setList} pos="relative" data-testid="frame-navigator-list">
      {c.items.map((item) =>
        createElement("myoxus-frame-card", {
          key: item.id,
          "data-frame-id": item.id,
          ref: item.mount,
        }),
      )}
      {c.indicatorY !== undefined ? (
        <Box
          pos="absolute"
          left={0}
          right={0}
          h={2}
          bg="myoxus"
          style={{ transform: `translateY(${c.indicatorY}px)` }}
          data-testid="frame-insert-indicator"
        />
      ) : null}
    </Stack>
  );
}

export function EditorFrameCard({
  controls: c,
}: {
  controls: EditorFrameCardControls;
}) {
  return (
    <ReferenceCard
      size="preview"
      contained
      selected={c.selected}
      title={<Box ref={c.mountTitle} />}
      data-testid="frame-navigator-card"
    >
      <Box
        pos="relative"
        onClick={(e) => c.select(e.nativeEvent)}
        onDoubleClick={(e) => c.fit(e.nativeEvent)}
        onMouseDown={(e) => c.drag(e.nativeEvent)}
      >
        <Box ref={c.mountPreview} />
        {c.count !== undefined ? (
          <Box pos="absolute" bottom={0} left={0}>
            <Badge>{c.count}</Badge>
          </Box>
        ) : null}
      </Box>
    </ReferenceCard>
  );
}

export function EditorFrameTitle({
  controls: c,
}: {
  controls: EditorFrameTitleControls;
}) {
  return (
    // The rich-text title editor is positioned against the actual native title.
    <Group
      ref={c.setContainer}
      wrap="nowrap"
      pos="relative"
      onClick={(e) => e.stopPropagation()}
    >
      <MyoxusText
        component="span"
        typographySlot="dense-label"
        tone="secondary"
      >
        {c.index + 1}
      </MyoxusText>
      <Box
        component="span"
        ref={c.setTitle}
        flex={1}
        miw={0}
        onDoubleClick={(e) => c.edit(e.nativeEvent)}
      >
        <MyoxusText component="span" truncate typographySlot="body-small">
          {c.title}
        </MyoxusText>
      </Box>
    </Group>
  );
}
