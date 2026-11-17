import { AILoading } from "../chat-panel/ai-loading";
import { ChatMessageAssistant } from "../chat-panel/message/assistant";
import { ChatMessageUser } from "../chat-panel/message/user";
import { AIChatAddContext } from "../components/ai-chat-add-context";
import { ChatPanelAddPopover } from "../components/ai-chat-chips/add-popover";
import { ChatPanelCandidatesPopover } from "../components/ai-chat-chips/candidates-popover";
import { ChatPanelChips } from "../components/ai-chat-chips/chat-panel-chips";
import { ChatPanelChip } from "../components/ai-chat-chips/chip";
import { ChatPanelDocChip } from "../components/ai-chat-chips/doc-chip";
import { AIChatComposer } from "../components/ai-chat-composer";
import { AIChatContent } from "../components/ai-chat-content";
import { AIChatInput } from "../components/ai-chat-input";
import { ChatInputPreference } from "../components/ai-chat-input/preference-popup";
import { AIChatMessages } from "../components/ai-chat-messages/ai-chat-messages";
import { AIHistoryClear } from "../components/ai-history-clear";
import { AssistantAvatar } from "../components/ai-message-content/assistant-avatar";
import { ChatCopyMore } from "../components/copy-more";
import { effects as componentPlaygroundEffects } from "../components/playground";
import { AIChatBlockPeekView } from "../peek-view/chat-block-peek-view";
import { type AppEffectElementTag, appEffectElementTags } from "./registry";
import { registerAISharedEffects } from "./shared";

const appRegistries = new WeakSet<CustomElementRegistry>();
const appElements = {
  "chat-copy-more": ChatCopyMore,
  "ai-loading": AILoading,
  "ai-chat-content": AIChatContent,
  "ai-chat-messages": AIChatMessages,
  "ai-chat-input": AIChatInput,
  "ai-chat-add-context": AIChatAddContext,
  "ai-chat-composer": AIChatComposer,
  "chat-panel-chips": ChatPanelChips,
  "ai-history-clear": AIHistoryClear,
  "chat-panel-add-popover": ChatPanelAddPopover,
  "chat-input-preference": ChatInputPreference,
  "chat-panel-candidates-popover": ChatPanelCandidatesPopover,
  "chat-panel-doc-chip": ChatPanelDocChip,
  "chat-panel-chip": ChatPanelChip,
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
