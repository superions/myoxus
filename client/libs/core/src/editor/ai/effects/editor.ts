import { AIScrollableTextRenderer } from "../components/ai-scrollable-text-renderer";
import {
  MYOXUS_AI_PANEL_WIDGET,
  MyoxusAIPanelWidget,
} from "../widgets/ai-panel/ai-panel";
import {
  MYOXUS_BLOCK_DIFF_WIDGET_FOR_BLOCK,
  MyoxusBlockDiffWidgetForBlock,
} from "../widgets/block-diff/block";
import {
  MYOXUS_BLOCK_DIFF_WIDGET_FOR_PAGE,
  MyoxusBlockDiffWidgetForPage,
} from "../widgets/block-diff/page";
import {
  BlockDiffPlayground,
  MYOXUS_BLOCK_DIFF_PLAYGROUND,
} from "../widgets/block-diff/playground";
import {
  EdgelessCopilotWidget,
  MYOXUS_EDGELESS_COPILOT_WIDGET,
} from "../widgets/edgeless-copilot";
import { EdgelessCopilotPanel } from "../widgets/edgeless-copilot-panel";
import { interactiveEditorTags } from "./registry";
import { registerAISharedEffects } from "./shared";

const editorRegistries = new WeakSet<CustomElementRegistry>();
export function registerAIEditorEffects() {
  const registry = customElements;
  if (editorRegistries.has(registry)) return;
  registerAISharedEffects();
  const elements = {
    "ai-scrollable-text-renderer": AIScrollableTextRenderer,
    [MYOXUS_BLOCK_DIFF_PLAYGROUND]: BlockDiffPlayground,
    [MYOXUS_AI_PANEL_WIDGET]: MyoxusAIPanelWidget,
    [MYOXUS_EDGELESS_COPILOT_WIDGET]: EdgelessCopilotWidget,
    [MYOXUS_BLOCK_DIFF_WIDGET_FOR_BLOCK]: MyoxusBlockDiffWidgetForBlock,
    [MYOXUS_BLOCK_DIFF_WIDGET_FOR_PAGE]: MyoxusBlockDiffWidgetForPage,
    "edgeless-copilot-panel": EdgelessCopilotPanel,
  } satisfies Record<
    (typeof interactiveEditorTags)[number],
    CustomElementConstructor
  >;
  for (const tag of interactiveEditorTags) registry.define(tag, elements[tag]);
  editorRegistries.add(registry);
}
