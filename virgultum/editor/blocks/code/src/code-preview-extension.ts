import { createIdentifier } from "@virgultum/global/di";
import type { CodeBlockModel } from "@virgultum/model";
import type { ExtensionType } from "@virgultum/store";
import type { HTMLTemplateResult } from "lit";

import type { CodeBlockComponent } from "./code-block.js";

export type CodeBlockPreviewRenderer = (
  model: CodeBlockModel,
  blockComponent?: CodeBlockComponent,
) => HTMLTemplateResult | null;

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
