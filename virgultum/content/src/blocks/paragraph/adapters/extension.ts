import type { ExtensionType } from "@virgultum/core/store";

import { ParagraphBlockHtmlAdapterExtension } from "./html";
import { ParagraphBlockMarkdownAdapterExtension } from "./markdown";
import { ParagraphBlockNotionHtmlAdapterExtension } from "./notion-html";
import { ParagraphBlockPlainTextAdapterExtension } from "./plain-text";

export const ParagraphBlockAdapterExtensions: ExtensionType[] = [
  ParagraphBlockHtmlAdapterExtension,
  ParagraphBlockMarkdownAdapterExtension,
  ParagraphBlockPlainTextAdapterExtension,
  ParagraphBlockNotionHtmlAdapterExtension,
];
