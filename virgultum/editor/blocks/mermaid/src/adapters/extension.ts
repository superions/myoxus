import type { ExtensionType } from "@virgultum/core/store";

import { MermaidBlockHtmlAdapterExtension } from "./html.js";
import { MermaidBlockMarkdownAdapterExtension } from "./markdown-matcher.js";
import { MermaidBlockPlainTextAdapterExtension } from "./plain-text.js";

export const MermaidBlockAdapterExtensions: ExtensionType[] = [
  MermaidBlockHtmlAdapterExtension,
  MermaidBlockMarkdownAdapterExtension,
  MermaidBlockPlainTextAdapterExtension,
];
