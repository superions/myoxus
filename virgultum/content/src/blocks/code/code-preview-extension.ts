import { createIdentifier } from "@virgultum/core/primitives/di";
import type { CodeBlockModel } from "@virgultum/core/models";
import type { ExtensionType } from "@virgultum/core/store";

import type { CodeBlockComponent } from "./code-block";

export type CodeBlockPreviewRenderer = (
  model: CodeBlockModel,
  blockComponent: CodeBlockComponent,
) => HTMLElement;

export type CodeBlockPreviewContext = {
  renderer: CodeBlockPreviewRenderer;
  lang: string;
};

export const CodeBlockPreviewIdentifier =
  createIdentifier<CodeBlockPreviewContext>("CodeBlockPreview");

export function CodeBlockPreviewExtension(
  lang: string,
  renderer: CodeBlockPreviewRenderer,
): ExtensionType {
  return {
    setup: (di) => {
      di.addImpl(CodeBlockPreviewIdentifier(lang), { renderer, lang });
    },
  };
}
