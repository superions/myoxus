import type { ExtensionType } from "@virgultum/store";

import { EmbedSyncedDocBlockHtmlAdapterExtension } from "./html.js";
import { EmbedSyncedDocMarkdownAdapterExtension } from "./markdown.js";
import { EmbedSyncedDocBlockPlainTextAdapterExtension } from "./plain-text.js";

export const EmbedSyncedDocBlockAdapterExtensions: ExtensionType[] = [
  EmbedSyncedDocBlockHtmlAdapterExtension,
  EmbedSyncedDocMarkdownAdapterExtension,
  EmbedSyncedDocBlockPlainTextAdapterExtension,
];
