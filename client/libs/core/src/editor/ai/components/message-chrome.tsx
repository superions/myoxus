// SPDX-License-Identifier: AGPL-3.0-or-later
import { useI18n } from "@myoxus/i18n";
import { BrainIcon, ArrowDownBigIcon } from "@myoxus/icons/react";
import {
  Avatar,
  Group,
  IconButton,
  MyoxusLoader,
  MyoxusText,
  Stack,
  ThemeIcon,
} from "@myoxus/ui-facade";
import type { ReactNode } from "react";

export function ChatAssistantIdentity({
  withDocs = false,
}: {
  withDocs?: boolean;
}) {
  const t = useI18n();
  return (
    <Group>
      <ThemeIcon variant="transparent" color="myoxus-text-secondary" size="sm">
        <BrainIcon size="calc(var(--mantine-spacing-lg) + var(--mantine-spacing-xs))" />
      </ThemeIcon>
      <MyoxusText typographySlot="body-small" tone="secondary">
        Myoxus AI
      </MyoxusText>
      {withDocs ? (
        <MyoxusText typographySlot="caption" tone="secondary">
          {t["com.myoxus.ai.chat-panel.with-docs"]()}
        </MyoxusText>
      ) : null}
    </Group>
  );
}

export function ChatUserIdentity({
  avatarUrl,
  name,
}: {
  avatarUrl?: string;
  name?: string;
}) {
  const t = useI18n();
  return (
    <Avatar
      kind="user"
      size="sm"
      url={avatarUrl}
      name={name || t["com.myoxus.common.you"]()}
    />
  );
}

export function ChatLoading() {
  const t = useI18n();
  return (
    <Group role="status">
      <MyoxusLoader />
      <MyoxusText tone="secondary">
        {t["com.myoxus.ai.chat-panel.generating"]()}
      </MyoxusText>
    </Group>
  );
}

export function ChatConversation({
  loading,
  empty,
  children,
}: {
  loading: boolean;
  empty: boolean;
  children?: ReactNode;
}) {
  const t = useI18n();
  return (
    <Stack data-testid="chat-panel-messages-container">
      {empty ? (
        <Stack data-testid="chat-panel-messages-placeholder">
          <Group>
            <ThemeIcon variant="transparent" color="myoxus-text-secondary">
              <BrainIcon size="calc(var(--mantine-spacing-lg) + var(--mantine-spacing-xs))" />
            </ThemeIcon>
            {loading ? <MyoxusLoader /> : null}
          </Group>
          <MyoxusText
            data-testid={
              loading ? "chat-panel-loading-state" : "chat-panel-empty-state"
            }
            tone={loading ? "secondary" : "primary"}
          >
            {loading
              ? t["com.myoxus.ai.chat-panel.loading-history"]()
              : t["com.myoxus.ai.chat-panel.welcome"]()}
          </MyoxusText>
        </Stack>
      ) : (
        children
      )}
    </Stack>
  );
}

export function ChatScrollToLatest({ onClick }: { onClick: () => void }) {
  const t = useI18n();
  return (
    <Group justify="center">
      <IconButton
        size="small"
        data-testid="chat-panel-scroll-down-indicator"
        aria-label={t["com.myoxus.ai.chat-panel.scroll-latest"]()}
        tooltip={t["com.myoxus.ai.chat-panel.scroll-latest"]()}
        onClick={onClick}
      >
        <ArrowDownBigIcon />
      </IconButton>
    </Group>
  );
}

/** Newlines remain content, without a second scrolling surface or local font. */
export function ChatPlainText({ text }: { text: string }) {
  return (
    <MyoxusText component="div" preserveWhitespace>
      {text}
    </MyoxusText>
  );
}

export function ChatMessageSurface({
  assistant,
  identity,
  children,
}: {
  assistant: boolean;
  identity?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <Stack
      data-myoxus-ui-role={
        assistant ? "chat-assistant-message" : "chat-user-message"
      }
    >
      {identity}
      {children}
    </Stack>
  );
}

export function ChatDisclaimer({ children }: { children?: ReactNode }) {
  return (
    <Stack>
      <MyoxusText typographySlot="caption" tone="secondary" component="div">
        {children}
      </MyoxusText>
    </Stack>
  );
}
