import type { ExtensionType, Schema, Workspace } from "@virgultum/store";
import {
  type DocEmbedProvider,
  type EditorI18nService,
} from "@virgultum/shared/services";

import {
  ImportDoc,
  type OnFailHandler,
  type OnSuccessHandler,
} from "./import-doc.js";

export function showImportModal({
  schema,
  collection,
  extensions,
  onSuccess,
  onFail,
  container = document.body,
  abortController = new AbortController(),
  access,
  i18n,
}: {
  schema: Schema;
  collection: Workspace;
  extensions: ExtensionType[];
  onSuccess?: OnSuccessHandler;
  onFail?: OnFailHandler;
  multiple?: boolean;
  container?: HTMLElement;
  abortController?: AbortController;
  access?: DocEmbedProvider;
  i18n?: EditorI18nService;
}) {
  const importDoc = new ImportDoc(
    collection,
    schema,
    extensions,
    onSuccess,
    onFail,
    abortController,
    access,
    i18n,
  );
  container.append(importDoc);
  abortController.signal.addEventListener("abort", () => importDoc.remove());
  return importDoc;
}
