// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ExtensionType } from "@virgultum/store";

import { EventBlockHtmlAdapterExtension } from "./html.js";
import { EventBlockMarkdownAdapterExtension } from "./markdown.js";
import { EventBlockPlainTextAdapterExtension } from "./plain-text.js";

export const EventBlockAdapterExtensions: ExtensionType[] = [
  EventBlockHtmlAdapterExtension,
  EventBlockMarkdownAdapterExtension,
  EventBlockPlainTextAdapterExtension,
];
