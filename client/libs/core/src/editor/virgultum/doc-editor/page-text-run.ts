// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  isMyoxusLabelTone,
  myoxusTextStyles,
} from "@virgultum/core/styles/text";
import type { MyoxusTextAttributes } from "@virgultum/core/types";

/** Shared text ink for the editable Page and inert document-card excerpts. */
export function pageTextRun(
  doc: Document,
  insert: string,
  a: Record<string, unknown>,
): Node {
  let node: Node = doc.createTextNode(insert);
  for (const [mark, tag] of Object.entries({
    bold: "strong",
    italic: "em",
    underline: "u",
    strike: "s",
    code: "code",
  })) {
    if (a[mark]) {
      const el = doc.createElement(tag);
      // The global UI reset removes these three native document marks.
      if (mark === "italic") el.style.fontStyle = "italic";
      if (mark === "underline") el.style.textDecorationLine = "underline";
      if (mark === "strike") el.style.textDecorationLine = "line-through";
      el.append(node);
      node = el;
    }
  }
  if (a.color || a.background || a.code || isMyoxusLabelTone(a.labelTone)) {
    const el = doc.createElement("span");
    for (const [key, value] of Object.entries(
      myoxusTextStyles(a as MyoxusTextAttributes),
    )) {
      if (value != null) el.style.setProperty(key, String(value));
    }
    if (isMyoxusLabelTone(a.labelTone))
      el.dataset.myoxusLabelTone = a.labelTone;
    el.append(node);
    node = el;
  }
  return node;
}
