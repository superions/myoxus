import { FrameworkProvider } from "@myoxus/infra";
import {
  type ViewExtensionContext,
  ViewExtensionProvider,
} from "@virgultum/editor/ext-loader";
import { z } from "zod";

import { CodeBlockPreviewExtension } from "@virgultum/editor/blocks/code";
import { EditorChromeHostIdentifier } from "@virgultum/editor/shared/services";
import { convertMermaidCodeBlockCommand } from "@virgultum/block-mermaid";

function previewExtension(language: "html" | "mermaid" | "typst") {
  return CodeBlockPreviewExtension(language, (anchor, model, block) =>
    block.std.get(EditorChromeHostIdentifier).mountCodePreview(anchor, {
      language,
      getSource: () => model.props.text.toString(),
      subscribe: (notify) => model.props.text$.subscribe(notify),
      convertMermaid:
        language === "mermaid" && !block.store.readonly
          ? () => {
              if (!block.store.readonly)
                block.std.command.exec(convertMermaidCodeBlockCommand, {
                  model,
                });
            }
          : undefined,
    }),
  );
}

const optionsSchema = z.object({
  framework: z.instanceof(FrameworkProvider).optional(),
});

export class CodeBlockPreviewViewExtension extends ViewExtensionProvider {
  override name = "code-block-preview";

  override schema = optionsSchema;

  override setup(
    context: ViewExtensionContext,
    options?: z.infer<typeof optionsSchema>,
  ) {
    super.setup(context, options);
    context.register([
      previewExtension("html"),
      previewExtension("mermaid"),
      previewExtension("typst"),
    ]);
  }
}
