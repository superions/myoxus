import type { ExtensionType } from "@virgultum/core/store";

import { LatexMarkdownAdapterExtensions } from "./markdown/index";
import { LatexBlockNotionHtmlAdapterExtension } from "./notion-html";
import { LatexBlockPlainTextAdapterExtension } from "./plain-text";
import { LatexBlockHtmlAdapterExtension } from "./html";

export const LatexBlockAdapterExtensions: ExtensionType[] = [
  LatexMarkdownAdapterExtensions,
  LatexBlockNotionHtmlAdapterExtension,
  LatexBlockPlainTextAdapterExtension,
  LatexBlockHtmlAdapterExtension,
].flat();
