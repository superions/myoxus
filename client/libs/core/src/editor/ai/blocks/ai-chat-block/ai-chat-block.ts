import { signal } from "@preact/signals-core";
import { Card, Group, MyoxusText, Stack } from "@myoxus/ui-facade";
import { ChatWithAIIcon } from "./components/icon";
import { Peekable } from "@virgultum/editor/components/peek";
import { NativeBlockComponent } from "@virgultum/editor/blocks/surface";
import { createElement, type ReactNode } from "react";

import { ChatMessagesSchema } from "../../components/ai-chat-messages";
import { NativeAIWidgetUI } from "../../widgets/native-ui";
import { StoredChatMessages } from "./components/stored-chat-messages";
import type { AIChatBlockModel } from "./model";

export function readStoredMessages(source: string) {
  try {
    return ChatMessagesSchema.safeParse(JSON.parse(source)).data ?? [];
  } catch {
    return [];
  }
}

/** Both block views present the persisted snapshot. Opening a chat is a separate action. */
export function mountStoredAIChat(
  block: NativeBlockComponent<AIChatBlockModel>,
  anchor: HTMLElement,
) {
  const mount = block.std.getOptional(NativeAIWidgetUI);
  if (!mount || block.viewType !== "display") return;
  const view = signal<ReactNode>(null);
  const render = (source: string) => {
    const messages = readStoredMessages(source).slice(-2);
    view.value = createElement(
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
            messages,
            readOnly: true,
          }),
        ),
        createElement(
          Group,
          { gap: "sm" },
          createElement(ChatWithAIIcon),
          createElement(
            MyoxusText,
            { typographySlot: "caption" },
            "AI chat block",
          ),
        ),
      ),
    );
  };
  block.disposables.add(mount(anchor, view));
  block.disposables.add(block.model.props.messages$.subscribe(render));
}

@Peekable({
  enableOn: () => !BUILD_CONFIG.isMobileEdition,
})
export class AIChatBlockComponent extends NativeBlockComponent<AIChatBlockModel> {
  connectedCallback() {
    if (!this.connectBlock()) return;
    this.style.display = "block";
    this.contentEditable = "false";
    mountStoredAIChat(this, this);
  }

  override requestUpdate() {}
}

declare global {
  interface HTMLElementTagNameMap {
    "myoxus-ai-chat": AIChatBlockComponent;
  }
}
