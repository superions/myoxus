import type { EditorHost } from "@virgultum/std";

import type { DocTitle } from "./doc-title";

export function getDocTitleByEditorHost(
  editorHost: EditorHost,
): DocTitle | null {
  const docViewport = editorHost.closest(".myoxus-page-viewport");
  if (!docViewport) return null;
  return docViewport.querySelector("doc-title");
}
