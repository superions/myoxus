import type { ExtensionType } from "@virgultum/store";

import { AttachmentBlockMarkdownAdapterExtension } from "./markdown.js";
import { AttachmentBlockNotionHtmlAdapterExtension } from "./notion-html.js";

export const AttachmentBlockAdapterExtensions: ExtensionType[] = [
  AttachmentBlockNotionHtmlAdapterExtension,
  AttachmentBlockMarkdownAdapterExtension,
];
