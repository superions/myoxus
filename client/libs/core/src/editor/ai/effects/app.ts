import { AILoading } from "../chat-panel/ai-loading";
import { ChatMessageAssistant } from "../chat-panel/message/assistant";
import { ChatMessageUser } from "../chat-panel/message/user";
import { ChatPanelChips } from "../components/ai-chat-chips/chat-panel-chips";
import { AIChatComposer } from "../components/ai-chat-composer";
import { AIChatContent } from "../components/ai-chat-content";
import { AIChatInput } from "../components/ai-chat-input";
import { AIChatMessages } from "../components/ai-chat-messages/ai-chat-messages";
import { AIHistoryClear } from "../components/ai-history-clear";
import { AssistantAvatar } from "../components/ai-message-content/assistant-avatar";
import { effects as componentPlaygroundEffects } from "../components/playground";
import { AIChatBlockPeekView } from "../peek-view/chat-block-peek-view";
import { type AppEffectElementTag, appEffectElementTags } from "./registry";
import { registerAISharedEffects } from "./shared";

const appRegistries = new WeakSet<CustomElementRegistry>();
const appElements = {
  "ai-loading": AILoading,
  "ai-chat-content": AIChatContent,
  "ai-chat-messages": AIChatMessages,
  "ai-chat-input": AIChatInput,
  "ai-chat-composer": AIChatComposer,
  "chat-panel-chips": ChatPanelChips,
  "ai-history-clear": AIHistoryClear,
  "chat-assistant-avatar": AssistantAvatar,
  "chat-message-assistant": ChatMessageAssistant,
  "chat-message-user": ChatMessageUser,
  "ai-chat-block-peek-view": AIChatBlockPeekView,
} satisfies Record<AppEffectElementTag, CustomElementConstructor>;

export function registerAIAppEffects() {
  const registry = customElements;
  if (appRegistries.has(registry)) return;
  appRegistries.add(registry);

  registerAISharedEffects();
  componentPlaygroundEffects();

  for (const tag of appEffectElementTags) {
    customElements.define(tag, appElements[tag]);
  }
}
