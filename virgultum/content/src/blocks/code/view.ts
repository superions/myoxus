import {
  type ViewExtensionContext,
  ViewExtensionProvider,
} from "@virgultum/core/extensions";
import {
  BlockViewExtension,
  FlavourExtension,
  WidgetViewExtension,
} from "@virgultum/core/runtime";
import { SlashMenuConfigExtension } from "@virgultum/core/slash-menu";

import { getCodeClipboardExtensions } from "./clipboard/index";
import { CodeBlockConfigExtension } from "./code-block-config";
import {
  CodeBlockInlineManagerExtension,
  CodeBlockUnitSpecExtension,
} from "./code-block-inline";
import { CodeBlockHighlighter } from "./code-block-service";
import { CodeKeymapExtension } from "./code-keymap";
import { MYOXUS_CODE_TOOLBAR_WIDGET } from "./code-toolbar/index";
import { codeSlashMenuConfig } from "./configs/slash-menu";
import { effects } from "./effects";
import { CodeBlockMarkdownExtension } from "./markdown";

const codeToolbarWidget = WidgetViewExtension(
  "myoxus:code",
  MYOXUS_CODE_TOOLBAR_WIDGET,
  MYOXUS_CODE_TOOLBAR_WIDGET,
);

export class CodeBlockViewExtension extends ViewExtensionProvider {
  override name = "myoxus-code-block";

  override effect() {
    super.effect();
    effects();
  }

  override setup(context: ViewExtensionContext) {
    super.setup(context);
    context.register([
      FlavourExtension("myoxus:code"),
      CodeBlockHighlighter,
      BlockViewExtension("myoxus:code", "myoxus-code"),
      SlashMenuConfigExtension("myoxus:code", codeSlashMenuConfig),
      CodeKeymapExtension,
      CodeBlockMarkdownExtension,
      ...getCodeClipboardExtensions(),
    ]);
    context.register([
      CodeBlockInlineManagerExtension,
      CodeBlockUnitSpecExtension,
    ]);
    if (!this.isMobile(context.scope)) {
      context.register(codeToolbarWidget);
    } else {
      context.register(
        CodeBlockConfigExtension({
          showLineNumbers: false,
        }),
      );
    }
  }
}
