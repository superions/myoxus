import type { ExtensionType } from "@virgultum/store";

import { LatexBlockMarkdownAdapterExtension } from "./markdown.js";
import { LatexMarkdownPreprocessorExtension } from "./preprocessor.js";

export * from "./markdown.js";
export * from "./preprocessor.js";

export const LatexMarkdownAdapterExtensions: ExtensionType[] = [
  LatexMarkdownPreprocessorExtension,
  LatexBlockMarkdownAdapterExtension,
];
