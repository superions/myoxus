import type { ExtensionType } from "@virgultum/core/store";

import { LatexBlockMarkdownAdapterExtension } from "./markdown";
import { LatexMarkdownPreprocessorExtension } from "./preprocessor";

export * from "./markdown";
export * from "./preprocessor";

export const LatexMarkdownAdapterExtensions: ExtensionType[] = [
  LatexMarkdownPreprocessorExtension,
  LatexBlockMarkdownAdapterExtension,
];
