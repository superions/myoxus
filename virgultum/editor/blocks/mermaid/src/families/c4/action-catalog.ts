// SPDX-License-Identifier: AGPL-3.0-or-later

import { mermaidMessages as m } from "../../i18n.js";
import type {
  C4EditorReactHostProps,
  C4ParentIntent,
} from "./react-host-contract.js";

/** Page, Embedded and native toolbar consume one ordered semantic catalog. */
export function c4ActionCatalog(
  props: Pick<C4EditorReactHostProps, "model" | "readonly" | "displayOnly">,
) {
  if (props.readonly || props.displayOnly) return [];
  return [
    { intent: "header", label: props.model.headerLine, disabled: false },
    { intent: "addElement", label: m.visualAddElement(), disabled: false },
    { intent: "emptyBoundary", label: m.c4AddBoundary(), disabled: false },
    {
      intent: "relation",
      label: m.c4AddRelation(),
      disabled: !props.model.elements.length,
    },
    { intent: "comments", label: m.visualComments(), disabled: false },
    { intent: "more", label: m.visualMoreActions(), disabled: false },
  ] satisfies { intent: C4ParentIntent; label: string; disabled: boolean }[];
}
