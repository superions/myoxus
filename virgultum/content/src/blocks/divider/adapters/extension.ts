import type { ExtensionType } from "@virgultum/core/store";

import { DividerBlockHtmlAdapterExtension } from "./html";
import { DividerBlockMarkdownAdapterExtension } from "./markdown";
import { DividerBlockNotionHtmlAdapterExtension } from "./notion-html";
import { DividerBlockPlainTextAdapterExtension } from "./plain-text";

export const DividerBlockAdapterExtensions: ExtensionType[] = [
  DividerBlockHtmlAdapterExtension,
  DividerBlockMarkdownAdapterExtension,
  DividerBlockNotionHtmlAdapterExtension,
  DividerBlockPlainTextAdapterExtension,
];
