// SPDX-License-Identifier: AGPL-3.0-or-later
import { useI18n } from "@myoxus/i18n";
import { BrainIcon, ArrowDownBigIcon } from "@myoxus/icons/react";
import {
  Avatar,
  Box,
  Card,
  PageContentRail,
  Group,
  IconButton,
  MyoxusLoader,
  MyoxusText,
  Stack,
  Scrollable,
  Splitter,
  ThemeIcon,
  useLocalStorage,
} from "@myoxus/ui-facade";
import type { ReactNode } from "react";
import { ChatContentImages } from "./ai-message-content/images";

export function ChatAssistantIdentity({
  withDocs = false,
}: {
  withDocs?: boolean;
}) {
  const t = useI18n();
  return (
    <Group gap="xs">
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
    <Group gap="xs">
      <Avatar
        kind="user"
        size="sm"
        url={avatarUrl}
        name={name || t["com.myoxus.common.you"]()}
      />
      <MyoxusText typographySlot="body-small" tone="secondary">
        {name || t["com.myoxus.common.you"]()}
      </MyoxusText>
    </Group>
  );
}

export function ChatLoading() {
  const t = useI18n();
  return (
    <Group role="status" data-testid="ai-loading">
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

export function ChatUserMessage({
  avatarUrl,
  name,
  text,
  images,
}: {
  avatarUrl?: string;
  name?: string;
  text: string;
  images?: string[];
}) {
  return (
    <ChatMessageSurface
      assistant={false}
      identity={<ChatUserIdentity avatarUrl={avatarUrl} name={name} />}
    >
      {images?.length ? <ChatContentImages images={images} /> : null}
      {text ? (
        <Box
          data-testid="chat-content-pure-text"
          onCopy={(event) => event.stopPropagation()}
        >
          <MyoxusText component="div" preserveWhitespace>
            {text}
          </MyoxusText>
        </Box>
      ) : null}
    </ChatMessageSurface>
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
  const content = (
    <Stack
      gap="xs"
      data-testid={assistant ? undefined : "chat-message-user"}
      data-myoxus-ui-role={
        assistant ? "chat-assistant-message" : "chat-user-message"
      }
    >
      {identity}
      {children}
    </Stack>
  );
  return assistant ? (
    content
  ) : (
    <Group>
      <Card withBorder padding="sm">
        {content}
      </Card>
    </Group>
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

/** Keep the producer mounted while its artifact occupies the sidebar or shares the standalone route. */
export function ChatConversationLayout({
  children,
  preview,
  open,
  independent,
}: {
  children?: ReactNode;
  preview: ReactNode;
  open: boolean;
  independent: boolean;
}) {
  const [savedRatio, setSavedRatio] = useLocalStorage<number>({
    key: "chat-panel-split-view-size",
    defaultValue: 50,
    deserialize: (value) => {
      const parsed = Number(value);
      return Number.isFinite(parsed) && parsed >= 20 && parsed <= 80
        ? parsed
        : 50;
    },
    serialize: (value) => String(value),
  });
  const ratio =
    Number.isFinite(savedRatio) && savedRatio >= 20 && savedRatio <= 80
      ? savedRatio
      : 50;
  const main = (
    // Messages and composer own their spacing; the frame only distributes the viewport.
    <Stack
      gap={0}
      h="100%"
      w="100%"
      mih={0}
      inert={!independent && open}
      opacity={!independent && open ? 0 : undefined}
      justify={independent ? "center" : undefined}
      data-myoxus-ui-role="chat-conversation-main"
    >
      {children}
    </Stack>
  );
  if (!independent) {
    return (
      <Box pos="relative" h="100%" w="100%" mih={0}>
        {main}
        {open ? (
          <Box pos="absolute" inset={0}>
            {preview}
          </Box>
        ) : null}
      </Box>
    );
  }
  return (
    <Splitter
      sizes={open ? [ratio, 100 - ratio] : [100]}
      onSizeChange={(sizes) => {
        if (!open) return;
        const next = Number(sizes[0]);
        if (Number.isFinite(next) && next >= 20 && next <= 80) {
          setSavedRatio(next);
        }
      }}
      onResizeEnd={(_, sizes) => {
        const next = Number(sizes[0]);
        if (Number.isFinite(next) && next >= 20 && next <= 80) {
          setSavedRatio(next);
        }
      }}
    >
      <Splitter.Pane defaultSize={50} min={open ? 20 : 0} max={open ? 80 : 100}>
        <PageContentRail width="editor" fill>
          {main}
        </PageContentRail>
      </Splitter.Pane>
      {open ? (
        <Splitter.Pane defaultSize={50} min={20} max={80}>
          {preview}
        </Splitter.Pane>
      ) : null}
    </Splitter>
  );
}

/** The existing peek owns its session; only its native viewport is exposed for scrolling. */
export function ChatPeekConversation({
  header,
  children,
  composer,
  viewportRef,
}: {
  header: ReactNode;
  children?: ReactNode;
  composer: ReactNode;
  viewportRef: (element: HTMLDivElement | null) => void;
}) {
  return (
    <Stack
      h="100%"
      mih={0}
      p="md"
      gap="xs"
      data-myoxus-ui-role="chat-peek-conversation"
    >
      <Group justify="flex-end">{header}</Group>
      <Scrollable.Viewport fill scrollbars="y" ref={viewportRef}>
        <Stack>{children}</Stack>
      </Scrollable.Viewport>
      {composer}
    </Stack>
  );
}
