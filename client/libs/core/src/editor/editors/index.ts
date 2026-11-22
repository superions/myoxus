import { createReactComponentFromLit } from "@myoxus/lit-react";
import { DocTitle } from "@virgultum/editor/fragments/doc-title";
import React from "react";

import { PageEditor } from "./page-editor";

export type { EdgelessEditor } from "./edgeless-editor";
export * from "./page-editor";

export const LitDocEditor = createReactComponentFromLit({
  react: React,
  elementClass: PageEditor,
});

export const LitDocTitle = createReactComponentFromLit({
  react: React,
  elementClass: DocTitle,
});

export function editorEffects() {
  if (!customElements.get("page-editor"))
    customElements.define("page-editor", PageEditor);
}
