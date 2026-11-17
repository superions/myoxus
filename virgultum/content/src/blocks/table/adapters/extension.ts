import type { ExtensionType } from "@virgultum/core/store";

import { TableBlockHtmlAdapterExtension } from "./html";
import { TableBlockMarkdownAdapterExtension } from "./markdown";
import { TableBlockNotionHtmlAdapterExtension } from "./notion-html";
import { TableBlockPlainTextAdapterExtension } from "./plain-text";

export const TableBlockAdapterExtensions: ExtensionType[] = [
  TableBlockHtmlAdapterExtension,
  TableBlockMarkdownAdapterExtension,
  TableBlockNotionHtmlAdapterExtension,
  TableBlockPlainTextAdapterExtension,
];
