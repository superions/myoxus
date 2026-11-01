import {
  type ViewExtensionContext,
  ViewExtensionProvider,
} from "@virgultum/ext-loader";
import {
  BlockViewExtension,
  FlavourExtension,
  WidgetViewExtension,
} from "@virgultum/std";
import { SlashMenuConfigExtension } from "@virgultum/widget-slash-menu";
import { literal, unsafeStatic } from "lit/static-html.js";

import { getCodeClipboardExtensions } from "./clipboard/index.js";
import { CodeBlockConfigExtension } from "./code-block-config";
import {
  CodeBlockInlineManagerExtension,
  CodeBlockUnitSpecExtension,
} from "./code-block-inline.js";
import { CodeBlockHighlighter } from "./code-block-service.js";
import { CodeKeymapExtension } from "./code-keymap.js";
import { MYOXUS_CODE_TOOLBAR_WIDGET } from "./code-toolbar/index.js";
import { codeSlashMenuConfig } from "./configs/slash-menu.js";
import { effects } from "./effects.js";
import { CodeBlockMarkdownExtension } from "./markdown.js";

const codeToolbarWidget = WidgetViewExtension(
  "myoxus:code",
  MYOXUS_CODE_TOOLBAR_WIDGET,
  literal`${unsafeStatic(MYOXUS_CODE_TOOLBAR_WIDGET)}`,
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
      BlockViewExtension("myoxus:code", literal`myoxus-code`),
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
