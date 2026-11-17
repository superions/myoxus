import type { ExtensionType } from "@virgultum/core/store";

import { CodeBlockMarkdownAdapterExtension } from "./markdown";
import { CodeMarkdownPreprocessorExtension } from "./preprocessor";

export * from "./markdown";
export * from "./preprocessor";

export const CodeBlockMarkdownAdapterExtensions: ExtensionType[] = [
  CodeMarkdownPreprocessorExtension,
  CodeBlockMarkdownAdapterExtension,
];
