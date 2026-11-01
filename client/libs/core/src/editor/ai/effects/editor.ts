import { AIChatBlockComponent } from "../blocks/ai-chat-block/ai-chat-block";
import { EdgelessAIChatBlockComponent } from "../blocks/ai-chat-block/ai-chat-edgeless-block";
import { LitTranscriptionBlock } from "../blocks/ai-chat-block/ai-transcription-block";
import {
  AIChatBlockMessage,
  AIChatBlockMessages,
} from "../blocks/ai-chat-block/components/ai-chat-messages";
import {
  ChatImage,
  ChatImages,
} from "../blocks/ai-chat-block/components/chat-images";
import { ImagePlaceholder } from "../blocks/ai-chat-block/components/image-placeholder";
import { UserInfo } from "../blocks/ai-chat-block/components/user-info";
import { effects as componentAiItemEffects } from "../components/ai-item";
import { AIScrollableTextRenderer } from "../components/ai-scrollable-text-renderer";
import { AskAIButton } from "../components/ask-ai-button";
import { AskAIIcon } from "../components/ask-ai-icon";
import { AskAIPanel } from "../components/ask-ai-panel";
import {
  MYOXUS_AI_PANEL_WIDGET,
  MyoxusAIPanelWidget,
} from "../widgets/ai-panel/ai-panel";
import {
  AIPanelAnswer,
  AIPanelDivider,
  AIPanelError,
  AIPanelGenerating,
  AIPanelInput,
} from "../widgets/ai-panel/components";
import { AIFinishTip } from "../widgets/ai-panel/components/finish-tip";
import { GeneratingPlaceholder } from "../widgets/ai-panel/components/generating-placeholder";
import {
  MYOXUS_BLOCK_DIFF_WIDGET_FOR_BLOCK,
  MyoxusBlockDiffWidgetForBlock,
} from "../widgets/block-diff/block";
import { BlockDiffOptions } from "../widgets/block-diff/options";
import {
  MYOXUS_BLOCK_DIFF_WIDGET_FOR_PAGE,
  MyoxusBlockDiffWidgetForPage,
} from "../widgets/block-diff/page";
import {
  BlockDiffPlayground,
  BlockDiffPlaygroundModal,
  MYOXUS_BLOCK_DIFF_PLAYGROUND,
  MYOXUS_BLOCK_DIFF_PLAYGROUND_MODAL,
} from "../widgets/block-diff/playground";
import {
  EdgelessCopilotWidget,
  MYOXUS_EDGELESS_COPILOT_WIDGET,
} from "../widgets/edgeless-copilot";
import { EdgelessCopilotPanel } from "../widgets/edgeless-copilot-panel";
import {
  type EditorEffectElementTag,
  editorEffectElementTags,
} from "./registry";
import { registerAISharedEffects } from "./shared";

const editorRegistries = new WeakSet<CustomElementRegistry>();
const editorElements = {
  "ask-ai-icon": AskAIIcon,
  "ask-ai-button": AskAIButton,
  "ask-ai-panel": AskAIPanel,
  "myoxus-edgeless-ai-chat": EdgelessAIChatBlockComponent,
  "myoxus-ai-chat": AIChatBlockComponent,
  "ai-chat-block-message": AIChatBlockMessage,
  "ai-chat-block-messages": AIChatBlockMessages,
  "ai-scrollable-text-renderer": AIScrollableTextRenderer,
  "image-placeholder": ImagePlaceholder,
  "chat-image": ChatImage,
  "chat-images": ChatImages,
  "user-info": UserInfo,
  "generating-placeholder": GeneratingPlaceholder,
  "ai-finish-tip": AIFinishTip,
  "ai-panel-divider": AIPanelDivider,
  "ai-panel-answer": AIPanelAnswer,
  "ai-panel-input": AIPanelInput,
  "ai-panel-generating": AIPanelGenerating,
  "ai-panel-error": AIPanelError,
  "ai-block-diff-options": BlockDiffOptions,
  [MYOXUS_BLOCK_DIFF_PLAYGROUND]: BlockDiffPlayground,
  [MYOXUS_BLOCK_DIFF_PLAYGROUND_MODAL]: BlockDiffPlaygroundModal,
  [MYOXUS_AI_PANEL_WIDGET]: MyoxusAIPanelWidget,
  [MYOXUS_EDGELESS_COPILOT_WIDGET]: EdgelessCopilotWidget,
  [MYOXUS_BLOCK_DIFF_WIDGET_FOR_BLOCK]: MyoxusBlockDiffWidgetForBlock,
  [MYOXUS_BLOCK_DIFF_WIDGET_FOR_PAGE]: MyoxusBlockDiffWidgetForPage,
  "edgeless-copilot-panel": EdgelessCopilotPanel,
  "transcription-block": LitTranscriptionBlock,
} satisfies Record<EditorEffectElementTag, CustomElementConstructor>;

export function registerAIEditorEffects() {
  const registry = customElements;
  if (editorRegistries.has(registry)) return;
  editorRegistries.add(registry);

  registerAISharedEffects();
  componentAiItemEffects();

  for (const tag of editorEffectElementTags) {
    customElements.define(tag, editorElements[tag]);
  }
}
