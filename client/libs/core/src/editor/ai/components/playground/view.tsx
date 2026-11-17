// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { useI18n } from "@myoxus/i18n";
import {
  type ReactToLit,
  toReactNode,
  useLitPortalFactory,
} from "@myoxus/lit-react";
import {
  Card,
  Group,
  Modal,
  MyoxusText,
  PageContentRail,
  Stack,
} from "@myoxus/ui-facade";
import { Fragment, useMemo, type ReactNode } from "react";

export function PlaygroundDialog({
  open,
  onOpenChange,
  title,
  renderContent,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  renderContent: (render: ReactToLit) => ReturnType<ReactToLit> | null;
}) {
  // Modal descendants own these portals, including native popup focus and layering.
  const [render, portals] = useLitPortalFactory();
  const content = useMemo(() => renderContent(render), [renderContent, render]);
  return (
    <Modal open={open} onOpenChange={onOpenChange} title={title} fullScreen>
      {portals.map(({ id, portal }) => (
        <Fragment key={id}>{portal}</Fragment>
      ))}
      {content ? toReactNode(content) : null}
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
