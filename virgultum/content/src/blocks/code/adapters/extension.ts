import type { ExtensionType } from "@virgultum/core/store";

import { CodeBlockHtmlAdapterExtension } from "./html";
import { CodeBlockMarkdownAdapterExtensions } from "./markdown/index";
import { CodeBlockNotionHtmlAdapterExtension } from "./notion-html";
import { CodeBlockPlainTextAdapterExtension } from "./plain-text";

export const CodeBlockAdapterExtensions: ExtensionType[] = [
  CodeBlockHtmlAdapterExtension,
  CodeBlockMarkdownAdapterExtensions,
  CodeBlockPlainTextAdapterExtension,
  CodeBlockNotionHtmlAdapterExtension,
].flat();
