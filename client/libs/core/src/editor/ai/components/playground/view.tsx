// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { useI18n } from "@myoxus/i18n";
import {
  Card,
  Group,
  Modal,
  MyoxusText,
  PageContentRail,
  Stack,
} from "@myoxus/ui-facade";
import type { ReactNode } from "react";

export function PlaygroundDialog({
  open,
  onOpenChange,
  title,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: ReactNode;
}) {
  return (
    <Modal open={open} onOpenChange={onOpenChange} title={title} fullScreen>
      {children}
    </Modal>
  );
}

export function PlaygroundColumns({
  items,
}: {
  items: readonly { id: string; content: ReactNode }[];
}) {
  return (
    <PageContentRail width={items.length === 1 ? "narrow" : "full"} fill>
      <Group grow flex={1} align="stretch" wrap="nowrap" h="100%">
        {items.map((item) => (
          <Card key={item.id} withBorder fullHeight padding="sm">
            {item.content}
          </Card>
        ))}
      </Group>
    </PageContentRail>
  );
}

export function PlaygroundConversation({
  actions,
  children,
  composer,
  done,
  total,
}: {
  actions: ReactNode;
  children?: ReactNode;
  composer: ReactNode;
  done: number;
  total: number;
}) {
  const t = useI18n();
  return (
    <Stack h="100%" mih={0}>
      <Group justify="space-between">
        <MyoxusText typographySlot="body-small" tone="secondary">
          {total > 0 && done < total
            ? t.t("com.myoxus.ai.chat-panel.embedding-progress", {
                done,
                total,
              })
            : "Myoxus AI"}
        </MyoxusText>
        <Group>{actions}</Group>
      </Group>
      {children}
      {composer}
    </Stack>
  );
}
