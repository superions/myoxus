// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { ChatWithAiIcon } from "@myoxus/icons/react";
import { Card, Group, MyoxusText, Stack } from "@myoxus/ui-facade";
import { signal } from "@preact/signals-core";
import { NativeBlockComponent } from "@virgultum/editor/blocks/surface";
import { Peekable } from "@virgultum/editor/components/peek";
import { createElement, type ReactNode } from "react";

import { ChatMessagesSchema } from "../../components/ai-chat-messages";
import { chatI18n } from "../../components/chat-i18n";
import { NativeAIWidgetUI } from "../../widgets/native-ui";
import { StoredChatMessages } from "./components/stored-chat-messages";
import type { AIChatBlockModel } from "./model";

export function readStoredMessages(serialized: string) {
  try {
    return ChatMessagesSchema.safeParse(JSON.parse(serialized)).data ?? [];
  } catch {
    return [];
  }
}

/**
 * Mounts a read-only preview of the latest persisted messages for both page
 * and Edgeless AI chat blocks. Interactive continuation lives in the Peek view.
 */
export function mountStoredAIChat(
  block: NativeBlockComponent<AIChatBlockModel>,
  anchor: HTMLElement,
): void {
  const mount = block.std.getOptional(NativeAIWidgetUI);
  if (!mount || block.viewType !== "display") return;

  const content = signal<ReactNode>(null);
  const updatePreview = (serialized: string) => {
    const recentMessages = readStoredMessages(serialized).slice(-2);
    content.value = createElement(
      Card,
      {
        padding: "lg",
        style: { height: "100%", pointerEvents: "none", userSelect: "none" },
      },
      createElement(
        Stack,
        { h: "100%", gap: "xs", justify: "space-between" },
        createElement(
          "div",
          {
            style: {
              flex: "1 0 0",
              width: "100%",
              overflow: "hidden",
              maskImage:
                "linear-gradient(to bottom, var(--myoxus-background-primary-color) 25%, transparent)",
            },
          },
          createElement(StoredChatMessages, {
            host: block.host,
            messages: recentMessages,
            readOnly: true,
          }),
        ),
        createElement(
          Group,
          { gap: "sm" },
          createElement(ChatWithAiIcon),
          createElement(
            MyoxusText,
            { typographySlot: "caption" },
            chatI18n()["com.myoxus.ai.chat-panel.chat-block"](),
          ),
        ),
      ),
    );
  };

  block.disposables.add(mount(anchor, content));
  block.disposables.add(block.model.props.messages$.subscribe(updatePreview));
}

@Peekable({
  enableOn: () => !BUILD_CONFIG.isMobileEdition,
})
export class AIChatBlockComponent extends NativeBlockComponent<AIChatBlockModel> {
  connectedCallback(): void {
    if (!this.connectBlock()) return;
    this.style.display = "block";
    this.contentEditable = "false";
    mountStoredAIChat(this, this);
  }

  override requestUpdate(): void {}
}

declare global {
  interface HTMLElementTagNameMap {
    "myoxus-ai-chat": AIChatBlockComponent;
  }
}
