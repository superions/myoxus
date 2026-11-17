// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { useI18n } from "@myoxus/i18n";
import { OpenInNewIcon, YoutubeIcon } from "@myoxus/icons/react";
import {
  Avatar,
  Box,
  Center,
  Group,
  Image,
  Loading,
  MyoxusText,
  ReferenceCard,
} from "@myoxus/ui-facade";
import type { EditorYoutubeCardControls } from "@virgultum/editor/shared/services";

/** Provider URLs, media state and Page/Gfx commands remain editor-owned. */
export function EditorYoutubeCard({
  controls: c,
}: {
  controls: EditorYoutubeCardControls;
}) {
  const t = useI18n();
  return (
    <ReferenceCard
      size="preview"
      orientation="vertical"
      contained
      fullHeight
      selected={c.selected}
      title={c.loading ? t["com.myoxus.loading"]() : c.title}
      icon={c.loading ? <Loading /> : <YoutubeIcon />}
      metadata={
        !c.loading && (c.creator || c.creatorImage) ? (
          <Group gap="xs" wrap="nowrap">
            {c.creatorImage ? (
              <Avatar
                url={c.creatorImage}
                name={c.creator ?? undefined}
                size="xs"
              />
            ) : null}
            <MyoxusText typographySlot="dense-label" tone="secondary" truncate>
              {c.creator}
            </MyoxusText>
          </Group>
        ) : undefined
      }
      description={
        !c.loading && c.description ? (
          <MyoxusText
            typographySlot="dense-label"
            tone="secondary"
            lineClamp={2}
          >
            {c.description}
          </MyoxusText>
        ) : undefined
      }
      preview={
        <Box pos="relative" h="100%">
          {c.videoId ? (
            <>
              <Box
                component="iframe"
                id="ytplayer"
                src={`https://www.youtube.com/embed/${c.videoId}`}
                title={c.title}
                allow="fullscreen; autoplay; clipboard-write; encrypted-media; picture-in-picture; web-share"
                sandbox="allow-scripts allow-same-origin allow-presentation"
                loading="lazy"
                {...{ credentialless: true }}
                display="block"
                w="100%"
                h="100%"
                // Browser iframe borders are renderer geometry, not card chrome.
                style={{ border: 0 }}
              />
              <Box
                pos="absolute"
                inset={0}
                hidden={!c.showOverlay}
                data-testid="youtube-iframe-guard"
              />
              <Box
                pos="absolute"
                inset={0}
                hidden={!c.printImage}
                data-testid="youtube-print-preview"
              >
                <Image
                  src={`https://img.youtube.com/vi/${c.videoId}/maxresdefault.jpg`}
                  alt="YouTube Video"
                  loading="lazy"
                  w="100%"
                  h="100%"
                  fit="cover"
                />
              </Box>
            </>
          ) : !c.loading && c.image ? (
            <Image src={c.image} alt="banner" w="100%" h="100%" fit="cover" />
          ) : (
            <Center h="100%">
              <YoutubeIcon />
            </Center>
          )}
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
            www.youtube.com
          </MyoxusText>
          <OpenInNewIcon />
        </Group>
      }
      onClick={(event) => c.select(event.nativeEvent)}
      onDoubleClick={(event) => {
        event.stopPropagation();
        c.open();
      }}
      aria-busy={c.loading}
      data-testid="editor-youtube-card"
    />
  );
}
