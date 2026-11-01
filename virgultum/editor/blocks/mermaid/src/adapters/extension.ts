import type { ExtensionType } from "@virgultum/store";

import { MermaidBlockHtmlAdapterExtension } from "./html.js";
import { MermaidBlockMarkdownAdapterExtension } from "./markdown.js";
import { MermaidBlockPlainTextAdapterExtension } from "./plain-text.js";

export const MermaidBlockAdapterExtensions: ExtensionType[] = [
  MermaidBlockHtmlAdapterExtension,
  MermaidBlockMarkdownAdapterExtension,
  MermaidBlockPlainTextAdapterExtension,
];
