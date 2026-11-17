// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { useI18n } from "@myoxus/i18n";
import type { KeyboardEvent } from "react";
import { LoomLogoIcon, OpenInNewIcon } from "@myoxus/icons/react";
import {
  Box,
  Button,
  Center,
  Image,
  Loading,
  MyoxusText,
  ReferenceCard,
} from "@myoxus/ui-facade";
import type { EditorLoomCardControls } from "@virgultum/editor/shared/services";

// Let the focused native button finish activation and Tab traversal before editor handlers.
function stopActivationKey(event: KeyboardEvent) {
  if (
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    (event.key === "Tab" ||
      (!event.shiftKey && (event.key === " " || event.key === "Enter")))
  )
    event.stopPropagation();
}

/** Render the resource snapshot; the editor owns loading, selection and commands. */
export function EditorLoomCard({
  controls: c,
}: {
  controls: EditorLoomCardControls;
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
      icon={c.loading ? <Loading /> : <LoomLogoIcon />}
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
                src={`https://www.loom.com/embed/${c.videoId}?hide_title=true`}
                title={c.title}
                allow="fullscreen; autoplay; clipboard-write; encrypted-media; picture-in-picture; web-share"
                sandbox="allow-scripts allow-same-origin allow-presentation"
                loading="lazy"
                {...{ credentialless: true }}
                display="block"
                w="100%"
                h="100%"
                // Intrinsic iframe borders are player geometry, not card chrome.
                style={{ border: 0 }}
              />
              <Box
                pos="absolute"
                inset={0}
                hidden={!c.showOverlay}
                data-testid="loom-iframe-guard"
              />
            </>
          ) : !c.loading && c.image ? (
            <Image src={c.image} alt="" w="100%" h="100%" fit="cover" />
          ) : (
            <Center h="100%">
              <LoomLogoIcon />
            </Center>
          )}
        </Box>
      }
      footer={
        <Button
          variant="plain"
          suffix={<OpenInNewIcon />}
          onClick={c.open}
          onKeyDown={stopActivationKey}
          onKeyUp={stopActivationKey}
        >
          loom.com
        </Button>
      }
      onClick={(event) => c.select(event.nativeEvent)}
      onDoubleClick={(event) => {
        event.stopPropagation();
        c.open();
      }}
      aria-busy={c.loading}
      data-testid="editor-loom-card"
    />
  );
}
