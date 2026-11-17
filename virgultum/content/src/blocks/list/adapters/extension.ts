import type { ExtensionType } from "@virgultum/core/store";

import { ListBlockHtmlAdapterExtension } from "./html";
import { ListBlockMarkdownAdapterExtension } from "./markdown";
import { ListBlockNotionHtmlAdapterExtension } from "./notion-html";
import { ListBlockPlainTextAdapterExtension } from "./plain-text";

export const ListBlockAdapterExtensions: ExtensionType[] = [
  ListBlockHtmlAdapterExtension,
  ListBlockMarkdownAdapterExtension,
  ListBlockPlainTextAdapterExtension,
  ListBlockNotionHtmlAdapterExtension,
];
