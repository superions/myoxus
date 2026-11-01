import type { EditorSettingExt } from "@myoxus/core/modules/editor-setting/entities/editor-setting";
import type { FrameworkProvider } from "@myoxus/infra";
import { BookmarkBlockComponent } from "@virgultum/editor/blocks/bookmark";
import {
  EmbedFigmaBlockComponent,
  EmbedGithubBlockComponent,
  EmbedLoomBlockComponent,
  EmbedYoutubeBlockComponent,
} from "@virgultum/editor/blocks/embed";
import {
  EmbedLinkedDocBlockComponent,
  EmbedSyncedDocBlockComponent,
} from "@virgultum/editor/blocks/embed-doc";
import { SurfaceRefBlockSchema } from "@virgultum/editor/model";
import { ToolbarModuleExtension } from "@virgultum/editor/shared/services";
import { BlockFlavourIdentifier } from "@virgultum/editor/std";
import type { ExtensionType } from "@virgultum/editor/store";
import {
  createToolbarMoreMenuConfigV2,
  createExternalLinkableToolbarConfig,
  createSurfaceRefToolbarConfig,
  embedLinkedDocToolbarConfig,
  embedSyncedDocToolbarConfig,
  embedIframeToolbarConfig,
} from "./block-actions";
import {
  createOpenDocActionGroup,
  createEdgelessOpenDocActionGroup,
  createInlineReferenceToolbarConfig,
} from "./text-actions";
export { createToolbarMoreMenuConfig } from "./block-actions";
export const createCustomToolbarExtension = (
  settings: EditorSettingExt,
  baseUrl: string,
  framework?: FrameworkProvider,
): ExtensionType[] => {
  return [
    ToolbarModuleExtension({
      id: BlockFlavourIdentifier("custom:myoxus:*"),
      config: createToolbarMoreMenuConfigV2(baseUrl, framework),
    }),

    ToolbarModuleExtension({
      id: BlockFlavourIdentifier("custom:myoxus:bookmark"),
      config: createExternalLinkableToolbarConfig(BookmarkBlockComponent),
    }),

    ToolbarModuleExtension({
      id: BlockFlavourIdentifier("custom:myoxus:surface:bookmark"),
      config: createExternalLinkableToolbarConfig(BookmarkBlockComponent),
    }),

    ToolbarModuleExtension({
      id: BlockFlavourIdentifier("custom:myoxus:embed-figma"),
      config: createExternalLinkableToolbarConfig(EmbedFigmaBlockComponent),
    }),

    ToolbarModuleExtension({
      id: BlockFlavourIdentifier("custom:myoxus:surface:embed-figma"),
      config: createExternalLinkableToolbarConfig(EmbedFigmaBlockComponent),
    }),

    ToolbarModuleExtension({
      id: BlockFlavourIdentifier("custom:myoxus:embed-github"),
      config: createExternalLinkableToolbarConfig(EmbedGithubBlockComponent),
    }),

    ToolbarModuleExtension({
      id: BlockFlavourIdentifier("custom:myoxus:surface:embed-github"),
      config: createExternalLinkableToolbarConfig(EmbedGithubBlockComponent),
    }),

    ToolbarModuleExtension({
      id: BlockFlavourIdentifier("custom:myoxus:embed-loom"),
      config: createExternalLinkableToolbarConfig(EmbedLoomBlockComponent),
    }),

    ToolbarModuleExtension({
      id: BlockFlavourIdentifier("custom:myoxus:surface:embed-loom"),
      config: createExternalLinkableToolbarConfig(EmbedLoomBlockComponent),
    }),

    ToolbarModuleExtension({
      id: BlockFlavourIdentifier("custom:myoxus:embed-youtube"),
      config: createExternalLinkableToolbarConfig(EmbedYoutubeBlockComponent),
    }),

    ToolbarModuleExtension({
      id: BlockFlavourIdentifier("custom:myoxus:surface:embed-youtube"),
      config: createExternalLinkableToolbarConfig(EmbedYoutubeBlockComponent),
    }),

    ToolbarModuleExtension({
      id: BlockFlavourIdentifier("custom:myoxus:embed-linked-doc"),
      config: {
        actions: [
          embedLinkedDocToolbarConfig.actions,
          createOpenDocActionGroup(EmbedLinkedDocBlockComponent, settings),
        ].flat(),
      },
    }),

    ToolbarModuleExtension({
      id: BlockFlavourIdentifier("custom:myoxus:surface:embed-linked-doc"),
      config: {
        actions: [
          embedLinkedDocToolbarConfig.actions,
          createOpenDocActionGroup(EmbedLinkedDocBlockComponent, settings),
          createEdgelessOpenDocActionGroup(EmbedLinkedDocBlockComponent),
        ].flat(),

        when: (ctx) => ctx.getSurfaceModels().length === 1,
      },
    }),

    ToolbarModuleExtension({
      id: BlockFlavourIdentifier("custom:myoxus:embed-synced-doc"),
      config: {
        actions: [
          embedSyncedDocToolbarConfig.actions,
          createOpenDocActionGroup(EmbedSyncedDocBlockComponent, settings),
        ].flat(),
      },
    }),

    ToolbarModuleExtension({
      id: BlockFlavourIdentifier("custom:myoxus:surface:embed-synced-doc"),
      config: {
        actions: [
          // the open actions are provided by the header of embed-edgeless-synced-doc-block
          {
            id: "A.open-doc",
            when: () => false,
          },
        ].flat(),
      },
    }),

    ToolbarModuleExtension({
      id: BlockFlavourIdentifier("custom:myoxus:reference"),
      config: createInlineReferenceToolbarConfig(settings),
    }),

    ToolbarModuleExtension({
      id: BlockFlavourIdentifier("custom:myoxus:embed-iframe"),
      config: embedIframeToolbarConfig,
    }),

    ToolbarModuleExtension({
      id: BlockFlavourIdentifier("custom:myoxus:surface:embed-iframe"),
      config: {
        actions: [embedIframeToolbarConfig.actions].flat(),

        when: (ctx) => ctx.getSurfaceModels().length === 1,
      },
    }),

    ToolbarModuleExtension({
      id: BlockFlavourIdentifier(
        `custom:${SurfaceRefBlockSchema.model.flavour}`,
      ),
      config: createSurfaceRefToolbarConfig(baseUrl),
    }),
  ];
};
