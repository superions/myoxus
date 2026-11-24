import type { MountReactPortal, ReactToLit } from "@myoxus/lit-react";
import { aiWidgetUI, nativeAIWidgetUI } from "../../ai/widgets/native-ui";
import { decorateEditorEmbeddedUI } from "../editor-view/embedded-ui-root";
import { toolbarAIEntryConfig } from "@myoxus/core/editor/ai";
import { AIChatBlockComponent } from "../../ai/blocks/ai-chat-block/ai-chat-block";
import { EdgelessAIChatBlockComponent } from "../../ai/blocks/ai-chat-block/ai-chat-edgeless-block";
import { TranscriptionBlockView } from "../../ai/blocks/ai-chat-block/ai-transcription-block";
import { storedBlockTags } from "../../ai/effects/registry";
import { AIChatBlockSpec } from "@myoxus/core/editor/ai/blocks";
import { AITranscriptionBlockSpec } from "@myoxus/core/editor/ai/blocks/ai-chat-block/ai-transcription-block";
import { edgelessToolbarAIEntryConfig } from "@myoxus/core/editor/ai/entries/edgeless";
import { imageToolbarAIEntryConfig } from "@myoxus/core/editor/ai/entries/image-toolbar/setup-image-toolbar";
import { AICodeBlockWatcher } from "@myoxus/core/editor/ai/extensions/ai-code";
import { getAIEdgelessRootWatcher } from "@myoxus/core/editor/ai/extensions/ai-edgeless-root";
import { getAIPageRootWatcher } from "@myoxus/core/editor/ai/extensions/ai-page-root";
import { AiSlashMenuConfigExtension } from "@myoxus/core/editor/ai/extensions/ai-slash-menu";
import { CopilotTool } from "@myoxus/core/editor/ai/tool/copilot-tool";
import { aiPanelWidget } from "@myoxus/core/editor/ai/widgets/ai-panel/ai-panel";
import { edgelessCopilotWidget } from "@myoxus/core/editor/ai/widgets/edgeless-copilot";
import { FrameworkProvider } from "@myoxus/infra";
import {
  type ViewExtensionContext,
  ViewExtensionProvider,
} from "@virgultum/editor/ext-loader";
import { ToolbarModuleExtension } from "@virgultum/editor/shared/services";
import { BlockFlavourIdentifier } from "@virgultum/editor/std";
import { z } from "zod";

import {
  BlockDiffService,
  BlockDiffWatcher,
} from "../../ai/services/block-diff";
import { blockDiffWidgetForBlock } from "../../ai/widgets/block-diff/block";
import { blockDiffWidgetForPage } from "../../ai/widgets/block-diff/page";
import { blockDiffPlayground } from "../../ai/widgets/block-diff/playground";
import { EdgelessClipboardAIChatConfig } from "./edgeless-clipboard";

const optionsSchema = z.object({
  enable: z.boolean().optional(),
  reactToLit: z.custom<ReactToLit>().optional(),
  mountPortal: z.custom<MountReactPortal>().optional(),
  framework: z.instanceof(FrameworkProvider).optional(),
});

type AIViewOptions = z.infer<typeof optionsSchema>;

const registeredBlocks = new WeakSet<CustomElementRegistry>();
function registerStoredBlocks(registry: CustomElementRegistry) {
  if (registeredBlocks.has(registry)) return;
  const elements = {
    "myoxus-edgeless-ai-chat": EdgelessAIChatBlockComponent,
    "myoxus-ai-chat": AIChatBlockComponent,
    "transcription-block": TranscriptionBlockView,
  } satisfies Record<
    (typeof storedBlockTags)[number],
    CustomElementConstructor
  >;
  for (const tag of storedBlockTags) registry.define(tag, elements[tag]);
  registeredBlocks.add(registry);
}

export class AIViewExtension extends ViewExtensionProvider<AIViewOptions> {
  override name = "myoxus-ai-view-extension";

  override schema = optionsSchema;

  override setup(context: ViewExtensionContext, options?: AIViewOptions) {
    super.setup(context, options);
    const framework = options?.framework;
    if (!framework) return;

    if (options.reactToLit) {
      const render = options.reactToLit;
      context.register(
        aiWidgetUI((view) => render(view, true, decorateEditorEmbeddedUI)),
      );
    }

    if (options.mountPortal)
      context.register(nativeAIWidgetUI(options.mountPortal));

    // Stored blocks remain readable after the workspace disables Copilot.
    if (typeof customElements !== "undefined")
      registerStoredBlocks(customElements);
    context.register(AIChatBlockSpec).register(AITranscriptionBlockSpec);
    if (!options.enable) return;

    context
      .register(EdgelessClipboardAIChatConfig)
      .register(AICodeBlockWatcher)
      .register(
        ToolbarModuleExtension({
          id: BlockFlavourIdentifier("custom:myoxus:image"),
          config: imageToolbarAIEntryConfig(),
        }),
      );

    if (context.scope === "edgeless" || context.scope === "page") {
      context.register([
        aiPanelWidget,
        AiSlashMenuConfigExtension(),
        ToolbarModuleExtension({
          id: BlockFlavourIdentifier("custom:myoxus:note"),
          config: toolbarAIEntryConfig(),
        }),
      ]);
    }
    if (context.scope === "edgeless") {
      context.register([
        CopilotTool,
        edgelessCopilotWidget,
        getAIEdgelessRootWatcher(),
        // In note
        ToolbarModuleExtension({
          id: BlockFlavourIdentifier("custom:myoxus:surface:*"),
          config: edgelessToolbarAIEntryConfig(),
        }),
      ]);
    }
    if (context.scope === "page") {
      context.register([
        blockDiffWidgetForPage,
        blockDiffWidgetForBlock,
        getAIPageRootWatcher(),
        BlockDiffService,
        BlockDiffWatcher,
      ]);

      if (process.env.NODE_ENV === "development") {
        context.register([blockDiffPlayground]);
      }
    }
  }
}
