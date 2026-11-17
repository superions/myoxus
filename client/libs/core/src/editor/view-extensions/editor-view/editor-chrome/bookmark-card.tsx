// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { useState } from "react";
import { useI18n } from "@myoxus/i18n";
import { OpenInNewIcon, WebIcon } from "@myoxus/icons/react";
import { cssVar } from "@myoxus/theme";
import {
  Group,
  Image,
  Loading,
  MyoxusText,
  ReferenceCard,
  Badge,
} from "@myoxus/ui-facade";
import { getHostName } from "@virgultum/core/utils";
import type { EditorBookmarkCardControls } from "@virgultum/editor/shared/services";

/** Resource state and guarded commands stay with the mounted editor block. */
export function EditorBookmarkCard({
  controls: c,
}: {
  controls: EditorBookmarkCardControls;
}) {
  const t = useI18n();
  const citation = !!c.citationIdentifier;
  const compact = c.style === "list" || c.style === "cube";
  const hostName = getHostName(c.url);
  const title = citation
    ? c.title || c.url
    : c.loading
      ? t["Loading"]()
      : c.title ||
        (c.error ? hostName || t["com.myoxus.editor.toolbar.card-view"]() : "");
  const description = c.loading
    ? ""
    : c.description ||
      (c.error ? t["com.myoxus.editor.link.info-failed"]() : c.url);
  return (
    <ReferenceCard
      size={compact ? "small" : "preview"}
      orientation={
        c.style === "vertical" || c.style === "cube" ? "vertical" : "horizontal"
      }
      contained={c.inSurface}
      selected={c.selected}
      fullHeight={c.inSurface || c.style === "vertical"}
      title={title}
      description={
        citation ? c.description : !compact ? description : undefined
      }
      status={
        citation ? (
          <Badge tone={c.selected ? "info" : "neutral"}>
            {c.citationIdentifier}
          </Badge>
        ) : undefined
      }
      icon={
        citation ? (
          c.icon ? (
            <BookmarkIcon key={c.icon} src={c.icon} />
          ) : undefined
        ) : c.loading ? (
          <Loading />
        ) : (
          <BookmarkIcon key={c.icon} src={c.icon} />
        )
      }
      image={citation ? undefined : c.loading ? null : c.image}
      imageFallback={citation ? undefined : <WebIcon />}
      footer={
        citation ? undefined : (
          <Group
            gap="xs"
            wrap="nowrap"
            onClick={() => c.open()}
            data-testid="editor-bookmark-card-url"
          >
            <MyoxusText
              typographySlot="dense-label"
              tone={c.selected ? "link" : "secondary"}
              truncate
              title={c.url}
            >
              {hostName}
            </MyoxusText>
            <OpenInNewIcon />
          </Group>
        )
      }
      onClick={
        citation
          ? undefined
          : (event) => {
              event.stopPropagation();
              c.select();
            }
      }
      onDoubleClick={
        citation
          ? undefined
          : (event) => {
              event.stopPropagation();
              c.open();
            }
      }
      aria-busy={c.loading}
      data-testid="editor-bookmark-card"
      // Comment highlighting is an editor-owned state accent, separate from selection.
      style={
        c.commentHighlighted
          ? { outline: `2px solid ${cssVar("primaryColor")}` }
          : undefined
      }
    />
  );
}

/** Loading unmounts the resource, so retrying the same URI must get a fresh image attempt. */
function BookmarkIcon({ src }: { src: string | null }) {
  const [failed, setFailed] = useState(false);
  return src && !failed ? (
    <Image alt="" h="1em" w="1em" src={src} onError={() => setFailed(true)} />
  ) : (
    <WebIcon />
  );
}
