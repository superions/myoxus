import type { ExtensionType } from "@virgultum/store";

import { RootBlockHtmlAdapterExtension } from "./html.js";
import { RootBlockMarkdownAdapterExtension } from "./markdown.js";
import { RootBlockNotionHtmlAdapterExtension } from "./notion-html.js";

export const RootBlockAdapterExtensions: ExtensionType[] = [
  RootBlockHtmlAdapterExtension,
  RootBlockMarkdownAdapterExtension,
  RootBlockNotionHtmlAdapterExtension,
];
