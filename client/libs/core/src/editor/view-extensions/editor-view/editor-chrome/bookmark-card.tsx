// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { useI18n } from "@myoxus/i18n";
import { OpenInNewIcon, WebIcon } from "@myoxus/icons/react";
import { cssVar } from "@myoxus/theme";
import {
  AspectRatio,
  Box,
  Center,
  Grid,
  Group,
  Image,
  Loading,
  MyoxusText,
  Stack,
  SurfaceListItem,
  MediaPreviewIcon,
} from "@myoxus/ui-facade";
import { getHostName } from "@virgultum/shared/utils";
import type { EditorBookmarkCardControls } from "@virgultum/editor/shared/services";

/** Resource state and guarded commands stay with the mounted editor block. */
export function EditorBookmarkCard({
  controls,
}: {
  controls: EditorBookmarkCardControls;
}) {
  const t = useI18n();
  const hostName = getHostName(controls.url);
  const titleText = controls.loading
    ? t["Loading"]()
    : controls.title ||
      (controls.error
        ? hostName || t["com.myoxus.editor.toolbar.card-view"]()
        : "");
  const descriptionText = controls.loading
    ? ""
    : controls.description ||
      (controls.error
        ? t["com.myoxus.editor.link.info-failed"]()
        : controls.url);
  const titleIcon = controls.loading ? (
    <Loading />
  ) : controls.icon ? (
    <Image alt="" h="1em" src={controls.icon} w="1em" />
  ) : (
    <WebIcon />
  );
  const urlRow = (
    <Group
      gap="xs"
      onClick={() => controls.open()}
      wrap="nowrap"
      data-testid="editor-bookmark-card-url"
    >
      <MyoxusText
        tone={controls.selected ? "link" : "secondary"}
        typographySlot="dense-label"
        truncate
        title={controls.url}
      >
        {hostName}
      </MyoxusText>
      <OpenInNewIcon />
    </Group>
  );
  const titleRow = (
    <Group gap="xs" wrap="nowrap">
      {titleIcon}
      <MyoxusText
        typographySlot="body-small"
        truncate
        title={titleText}
        data-testid="editor-bookmark-card-title"
      >
        <strong>{titleText}</strong>
      </MyoxusText>
    </Group>
  );
  const description = descriptionText ? (
    <MyoxusText
      tone="secondary"
      typographySlot="dense-label"
      lineClamp={controls.style === "vertical" ? 6 : 2}
      preserveWhitespace
      data-testid="editor-bookmark-card-description"
    >
      {descriptionText}
    </MyoxusText>
  ) : null;
  // Native proportional layout keeps the thumbnail inside its card at any
  // document-column width; no viewport/element observer owns a second layout.
  const banner = (
    <AspectRatio ratio={2}>
      {controls.image && !controls.loading ? (
        <Image alt="" fit="cover" src={controls.image} />
      ) : (
        <Center>
          <MediaPreviewIcon>
            <WebIcon />
          </MediaPreviewIcon>
        </Center>
      )}
    </AspectRatio>
  );

  return (
    <SurfaceListItem
      component="div"
      appearance="card"
      selected={controls.selected}
      fullHeight={controls.inSurface || controls.style === "vertical"}
      onClick={(event) => {
        event.stopPropagation();
        controls.select();
      }}
      onDoubleClick={(event) => {
        event.stopPropagation();
        controls.open();
      }}
      data-testid="editor-bookmark-card"
      aria-busy={controls.loading}
      // Keep the editor's comment-state accent independent of selection.
      style={
        controls.commentHighlighted
          ? { outline: `2px solid ${cssVar("primaryColor")}` }
          : undefined
      }
    >
      {controls.style === "horizontal" ? (
        <Grid columns={4} gap="sm" align="stretch">
          <Grid.Col span={3} miw={0}>
            <Stack gap="xs" h="100%" justify="space-between">
              <Stack gap="xs" miw={0}>
                {titleRow}
                {description}
              </Stack>
              {urlRow}
            </Stack>
          </Grid.Col>
          <Grid.Col span={1}>{banner}</Grid.Col>
        </Grid>
      ) : controls.style === "list" ? (
        <Group gap="xs" justify="space-between" wrap="nowrap">
          <Box miw={0} flex={1}>
            {titleRow}
          </Box>
          {urlRow}
        </Group>
      ) : controls.style === "vertical" ? (
        <Stack gap="sm" h="100%">
          {banner}
          <Stack gap="xs" miw={0} flex={1}>
            {titleRow}
            {description}
            <Box flex={1} />
            {urlRow}
          </Stack>
        </Stack>
      ) : (
        <Stack gap="xs" h="100%" align="flex-start">
          {titleIcon}
          <MyoxusText
            typographySlot="body-small"
            lineClamp={2}
            title={titleText}
            data-testid="editor-bookmark-card-title"
          >
            <strong>{titleText}</strong>
          </MyoxusText>
          <Box flex={1} />
          {urlRow}
        </Stack>
      )}
    </SurfaceListItem>
  );
}
