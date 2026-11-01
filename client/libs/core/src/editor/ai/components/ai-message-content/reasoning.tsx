// SPDX-License-Identifier: AGPL-3.0-or-later
import { useI18n } from "@myoxus/i18n";
import { ChevronDownIcon, ChevronUpIcon } from "@myoxus/icons/react";
import {
  Collapse,
  Group,
  IconButton,
  MyoxusText,
  Stack,
} from "@myoxus/ui-facade";
import { type ReactNode, useId, useState } from "react";

/** Local expansion stays with this portal across incoming chunks.
 * The existing rich-text template owns the content, not a second renderer.
 */
export function ReasoningSection({
  children,
  generating,
  identity,
  followedByContent,
}: {
  children?: ReactNode;
  generating: boolean;
  identity?: ReactNode;
  followedByContent: boolean;
}) {
  const t = useI18n();
  const [opened, setOpened] = useState(false);
  const contentId = useId();
  const label = t["com.myoxus.ai.chat-panel.reasoning"]();
  return (
    <Stack
      data-testid="chat-reasoning"
      aria-busy={generating}
      mb={followedByContent ? "md" : undefined}
    >
      <Group justify={identity ? "space-between" : "flex-end"} wrap="nowrap">
        {identity}
        <Group wrap="nowrap">
          {generating ? (
            <MyoxusText
              role="status"
              typographySlot="body-small"
              tone="primary"
              italic
              pending
            >
              {t["com.myoxus.ai.chat-panel.thinking"]()}
            </MyoxusText>
          ) : null}
          <IconButton
            size="small"
            data-testid="chat-reasoning-toggle"
            aria-label={label}
            tooltip={label}
            aria-expanded={opened}
            aria-controls={contentId}
            onClick={() => setOpened((value) => !value)}
          >
            {opened ? <ChevronUpIcon /> : <ChevronDownIcon />}
          </IconButton>
        </Group>
      </Group>
      <Collapse expanded={opened} id={contentId} keepMountedMode="display-none">
        <MyoxusText
          component="div"
          typographySlot="body-small"
          tone="secondary"
          italic
          data-testid="chat-reasoning-content"
          role="region"
          aria-label={label}
        >
          {children}
        </MyoxusText>
      </Collapse>
    </Stack>
  );
}
