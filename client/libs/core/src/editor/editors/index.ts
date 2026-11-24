import type { DocTitle } from "@virgultum/editor/fragments/doc-title";
import { createElement, type Ref } from "react";

export { DocumentViewport } from "./document-viewport";

export function DocumentTitle(props: {
  doc: DocTitle["doc"];
  placeholder?: string;
  ref?: Ref<DocTitle>;
}) {
  return createElement("doc-title", props);
}
