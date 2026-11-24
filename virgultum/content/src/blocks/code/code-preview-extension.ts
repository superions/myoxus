import { createIdentifier } from "@virgultum/core/primitives/di";
import type { CodeBlockModel } from "@virgultum/core/models";
import type { ExtensionType } from "@virgultum/core/store";

import type { CodeBlockComponent } from "./code-block";

export type MountCodeBlockPreview = (
  anchor: HTMLElement,
  model: CodeBlockModel,
  blockComponent: CodeBlockComponent,
) => () => void;

export type CodeBlockPreviewContext = {
  mount: MountCodeBlockPreview;
  lang: string;
};

export const CodeBlockPreviewIdentifier =
  createIdentifier<CodeBlockPreviewContext>("CodeBlockPreview");

export function CodeBlockPreviewExtension(
  lang: string,
  mount: MountCodeBlockPreview,
): ExtensionType {
  return {
    setup: (di) => {
      di.addImpl(CodeBlockPreviewIdentifier(lang), { mount, lang });
    },
  };
}
