import { CloudViewExtension } from "@myoxus/core/editor/view-extensions/cloud";
import { MyoxusEditorViewExtension } from "@myoxus/core/editor/view-extensions/editor-view/editor-view";
import { MyoxusThemeViewExtension } from "@myoxus/core/editor/view-extensions/theme";
import { configureEditorI18n } from "@myoxus/core/editor/virgultum/editor-i18n";
import { I18n } from "@myoxus/i18n";
import type { FrameworkProvider } from "@myoxus/infra";
import { CodeBlockViewExtension } from "@virgultum/editor/blocks/code/view";
import { DividerViewExtension } from "@virgultum/editor/blocks/divider/view";
import { LatexViewExtension as LatexBlockViewExtension } from "@virgultum/editor/blocks/latex/view";
import { ListViewExtension } from "@virgultum/editor/blocks/list/view";
import { NoteViewExtension } from "@virgultum/editor/blocks/note/view";
import { ParagraphViewExtension } from "@virgultum/editor/blocks/paragraph/view";
import { RootViewExtension } from "@virgultum/editor/blocks/root/view";
import {
  PeekViewExtension,
  type PeekViewService,
} from "@virgultum/editor/components/peek";
import {
  type ViewExtensionContext,
  ViewExtensionManager,
  ViewExtensionProvider,
} from "@virgultum/editor/ext-loader";
import { PlainTextClipboardConfig } from "@virgultum/editor/foundation/clipboard";
import { LatexInlineSpecExtension } from "@virgultum/editor/inlines/latex";
import { LatexViewExtension as LatexInlineViewExtension } from "@virgultum/editor/inlines/latex/view";
import { LinkInlineSpecExtension } from "@virgultum/editor/inlines/link";
import { LinkViewExtension } from "@virgultum/editor/inlines/link/view";
import { MentionInlineSpecExtension } from "@virgultum/editor/inlines/mention";
import { MentionViewExtension } from "@virgultum/editor/inlines/mention/view";
import {
  BackgroundInlineSpecExtension,
  BoldInlineSpecExtension,
  CodeInlineSpecExtension,
  ColorInlineSpecExtension,
  InlineSpecExtensions,
  ItalicInlineSpecExtension,
  StrikeInlineSpecExtension,
  UnderlineInlineSpecExtension,
} from "@virgultum/editor/inlines/preset";
import { ReferenceInlineSpecExtension } from "@virgultum/editor/inlines/reference";
import { ReferenceViewExtension } from "@virgultum/editor/inlines/reference/view";
import {
  DefaultOpenDocExtension,
  DocDisplayMetaService,
  DocModeService,
  EditorI18nExtension,
  FileSizeLimitService,
  FontConfigExtension,
  fontConfigSchema,
  FontLoaderService,
  PageViewportServiceExtension,
  ThemeService,
  ToolbarRegistryExtension,
} from "@virgultum/editor/shared/services";
import type { MyoxusTextAttributes } from "@virgultum/editor/shared/types";
import { InlineManagerExtension } from "@virgultum/editor/std/inline";
import { LinkedDocViewExtension } from "@virgultum/editor/widgets/linked-doc/view";
import { ToolbarViewExtension } from "@virgultum/editor/widgets/toolbar/view";
import { ViewportOverlayViewExtension } from "@virgultum/editor/widgets/viewport-overlay/view";
import { z } from "zod";

import { createCommentLinkedWidgetConfig } from "./linked-widget-config";

const commentEditorViewExtensionOptionsSchema = z.object({
  peekView: z.optional(z.custom<PeekViewService>()),
  fontConfig: z.optional(z.array(fontConfigSchema)),
});

export type CommentEditorViewExtensionOptions = z.infer<
  typeof commentEditorViewExtensionOptionsSchema
>;

class CommentEditorViewExtensionProvider extends ViewExtensionProvider<CommentEditorViewExtensionOptions> {
  override name = "comment-editor";

  override schema = commentEditorViewExtensionOptionsSchema;

  override setup(
    context: ViewExtensionContext,
    options?: CommentEditorViewExtensionOptions,
  ) {
    super.setup(context, options);
    context.register([
      EditorI18nExtension(configureEditorI18n()),
      ThemeService,
      DocModeService,
      DocDisplayMetaService,
      DefaultOpenDocExtension,
      FontLoaderService,
      ToolbarRegistryExtension,
      PageViewportServiceExtension,
      FileSizeLimitService,

      ...InlineSpecExtensions,
      InlineManagerExtension<MyoxusTextAttributes>({
        id: "DefaultInlineManager",
        specs: [
          BoldInlineSpecExtension.identifier,
          ItalicInlineSpecExtension.identifier,
          UnderlineInlineSpecExtension.identifier,
          StrikeInlineSpecExtension.identifier,
          CodeInlineSpecExtension.identifier,
          BackgroundInlineSpecExtension.identifier,
          ColorInlineSpecExtension.identifier,
          LatexInlineSpecExtension.identifier,
          ReferenceInlineSpecExtension.identifier,
          LinkInlineSpecExtension.identifier,
          MentionInlineSpecExtension.identifier,
        ],
      }),

      PlainTextClipboardConfig,
    ]);

    if (options?.fontConfig) {
      context.register(FontConfigExtension(options.fontConfig));
    }
    if (options?.peekView) {
      context.register(PeekViewExtension(options.peekView));
    }
  }
}

let manager: ViewExtensionManager | null = null;
export function getCommentEditorViewManager(framework: FrameworkProvider) {
  if (!manager) {
    manager = new ViewExtensionManager([
      CommentEditorViewExtensionProvider,

      // Blocks
      CodeBlockViewExtension,
      DividerViewExtension,
      LatexBlockViewExtension,
      ListViewExtension,

      NoteViewExtension,
      ParagraphViewExtension,
      RootViewExtension,

      // Inline
      LinkViewExtension,
      ReferenceViewExtension,
      MentionViewExtension,
      LatexInlineViewExtension,

      // Widget
      ToolbarViewExtension,
      ViewportOverlayViewExtension,
      LinkedDocViewExtension,

      MyoxusThemeViewExtension,
      MyoxusEditorViewExtension,

      // for rendering mentions
      CloudViewExtension,
    ]);

    manager.configure(ParagraphViewExtension, {
      getPlaceholder: () => {
        return I18n.t("com.myoxus.notification.comment-prompt");
      },
    });

    manager.configure(
      LinkedDocViewExtension,
      createCommentLinkedWidgetConfig(framework),
    );

    manager.configure(CloudViewExtension, {
      framework,
      enableCloud: true,
    });
  }
  return manager;
}
