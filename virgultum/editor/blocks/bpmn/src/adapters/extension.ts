import type { ExtensionType } from "@virgultum/store";

import { BpmnBlockHtmlAdapterExtension } from "./html.js";
import { BpmnBlockMarkdownAdapterExtension } from "./markdown.js";
import { BpmnBlockPlainTextAdapterExtension } from "./plain-text.js";

export const BpmnBlockAdapterExtensions: ExtensionType[] = [
  BpmnBlockHtmlAdapterExtension,
  BpmnBlockMarkdownAdapterExtension,
  BpmnBlockPlainTextAdapterExtension,
];
