// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: MIT

import { useEnableAI } from "@myoxus/core/components/hooks/myoxus/use-enable-ai";
import { type AIChatParams, AIProvider } from "@myoxus/core/editor/ai";
import type { MyoxusEditorContainer } from "@myoxus/core/editor/virgultum/doc-editor";
import {
  ViewContextSurface,
  ViewService,
} from "@myoxus/core/modules/workbench";
import { useI18n } from "@myoxus/i18n";
import { AiIcon } from "@myoxus/icons/react";
import { useService } from "@myoxus/infra";
import { useEffect } from "react";
import type { Subscription } from "rxjs";

import { EditorChatPanel } from "./panel";

const DOCUMENT_VIEW_FAMILIES = [
  "document-page",
  "document-edgeless",
  "journal",
] as const;

/**
 * Owns the complete document-chat integration: capability gating, external
 * open requests, stable Workbench registration and the chat panel lifecycle.
 */
export function AiChatSidecard({
  editor,
}: {
  editor: MyoxusEditorContainer | null;
}) {
  const enabled = useEnableAI();
  const view = useService(ViewService).view;
  const t = useI18n();

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const openChat = (params: AIChatParams | null) => {
      if (params) {
        view.showTool("chat");
      }
    };
    const subscriptions: Subscription[] = [
      AIProvider.slots.requestOpenWithChat.subscribe(openChat),
      AIProvider.slots.requestSendWithChat.subscribe(openChat),
    ];

    return () =>
      subscriptions.forEach((subscription) => subscription.unsubscribe());
  }, [enabled, view]);

  if (!enabled) {
    return null;
  }

  return (
    <ViewContextSurface
      surfaceId="chat"
      order={70}
      label={t["com.myoxus.sidebar.tab.chat"]()}
      tooltip={t["com.myoxus.sidebar.tab.chat.tooltip"]()}
      icon={<AiIcon />}
      viewFamilies={DOCUMENT_VIEW_FAMILIES}
      retainBodyWhenCollapsed
    >
      <EditorChatPanel editor={editor} />
    </ViewContextSurface>
  );
}
