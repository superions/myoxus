import type { ExtensionType } from "@virgultum/store";

import { EmbedLinkedDocHtmlAdapterExtension } from "./html.js";
import { EmbedLinkedDocMarkdownAdapterExtension } from "./markdown.js";
import { EmbedLinkedDocBlockPlainTextAdapterExtension } from "./plain-text.js";

export const EmbedLinkedDocBlockAdapterExtensions: ExtensionType[] = [
  EmbedLinkedDocHtmlAdapterExtension,
  EmbedLinkedDocMarkdownAdapterExtension,
  EmbedLinkedDocBlockPlainTextAdapterExtension,
];
