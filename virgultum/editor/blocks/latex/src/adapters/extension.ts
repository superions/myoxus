import type { ExtensionType } from "@virgultum/store";

import { LatexMarkdownAdapterExtensions } from "./markdown/index.js";
import { LatexBlockNotionHtmlAdapterExtension } from "./notion-html.js";
import { LatexBlockPlainTextAdapterExtension } from "./plain-text.js";
import { LatexBlockHtmlAdapterExtension } from "./html.js";

export const LatexBlockAdapterExtensions: ExtensionType[] = [
  LatexMarkdownAdapterExtensions,
  LatexBlockNotionHtmlAdapterExtension,
  LatexBlockPlainTextAdapterExtension,
  LatexBlockHtmlAdapterExtension,
].flat();
