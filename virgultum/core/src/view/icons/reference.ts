// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { BlockLinkIcon, DeleteIcon, LinkIcon } from "@myoxus/icons/native";
import type { ReferenceIconName } from "../../services/doc-display-meta-service";

const artwork = { BlockLinkIcon, DeleteIcon, LinkIcon };
/** Each mounted reference owns its SVG; the catalogue is trusted build output. */
export function createReferenceIcon(doc: Document, name: ReferenceIconName) {
  const template = doc.createElement("template");
  template.innerHTML = artwork[name];
  const icon = template.content.firstElementChild as SVGSVGElement;
  icon.setAttribute("width", "1.25em");
  icon.setAttribute("height", "1.25em");
  icon.style.verticalAlign = "middle";
  icon.style.fontSize = "inherit";
  icon.style.marginBottom = "0.1em";
  return icon;
}
