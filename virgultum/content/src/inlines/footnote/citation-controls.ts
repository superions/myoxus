// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { computed, signal, type ReadonlySignal } from "@preact/signals-core";
import type { CitationFootNote, FootNote } from "@virgultum/core/models";
import type {
  DocEmbedProvider,
  EditorCitationControls,
  EditorCitationState,
  LinkPreviewProvider,
} from "@virgultum/core/services";
import type { Workspace } from "@virgultum/core/store";

/** The existing hover controller owns positioning; this scope owns access and async work. */
export function citationControls(
  services: {
    workspace: Workspace;
    provider?: DocEmbedProvider | null;
    title: (id: string) => ReadonlySignal<string>;
    image: (url: string) => string;
    query: LinkPreviewProvider["query"];
    readonly: () => boolean;
  },
  target: HTMLElement,
  footnote: CitationFootNote,
  current: () => FootNote | null | undefined,
  abort: AbortController,
  navigate: (value: CitationFootNote, abort: AbortController) => void,
  update: (value: FootNote) => void,
): EditorCitationControls {
  const ref = footnote.reference;
  const provider = services.provider;
  const workspaceId = ref.workspaceId ?? services.workspace.id;
  const binding = ref.docId
    ? provider?.openReference?.(workspaceId, ref.docId)
    : undefined;
  const scope =
    !binding && ref.docId ? provider?.inWorkspace?.(workspaceId) : undefined;
  const context = () =>
    binding
      ? binding.target.value
      : scope
        ? { ...scope, docId: ref.docId! }
        : ref.workspaceId === undefined && !provider?.inWorkspace && ref.docId
          ? {
              access: provider,
              collection: services.workspace,
              docId: ref.docId,
            }
          : undefined;
  const data = signal(ref);
  const loading = signal(false);
  const live = () =>
    target.isConnected && !abort.signal.aborted && current() === footnote;
  const titles = new Map<string, ReadonlySignal<string>>();
  const localTitle = (docId: string) => {
    let title = titles.get(docId);
    if (!title) {
      title = services.title(docId);
      titles.set(docId, title);
    }
    return title.value;
  };
  const snapshot = computed<EditorCitationState>(() => {
    const resolved = context();
    const readable = resolved?.access?.readable(resolved.docId).value;
    const available =
      ref.type === "doc" ? readable === true : !!(ref.url || ref.fileName);
    const local = resolved?.collection.id === services.workspace.id;
    const label =
      ref.type === "doc"
        ? available
          ? local
            ? localTitle(resolved!.docId)
            : (resolved?.access?.referenceTitleSignal?.(resolved.docId)
                ?.value ?? "")
          : ""
        : ref.type === "attachment"
          ? (ref.fileName ?? "")
          : data.value.title || ref.url || "";
    return {
      kind: ref.type,
      title: label,
      description: ref.type === "url" ? data.value.description : undefined,
      tooltip:
        ref.type === "url"
          ? [data.value.title, ref.url].filter(Boolean).join("\n")
          : label,
      loading:
        ref.type === "doc"
          ? !!binding &&
            (resolved === undefined || (!!resolved && readable === undefined))
          : loading.value,
      available,
      docId: local && available ? resolved?.docId : undefined,
      fileType: ref.fileType,
      image:
        ref.type === "url" && data.value.favicon
          ? services.image(data.value.favicon)
          : undefined,
    };
  });
  abort.signal.addEventListener(
    "abort",
    () => {
      binding?.dispose();
      scope?.dispose();
    },
    { once: true },
  );
  if (ref.type === "url" && ref.url && !ref.title && !ref.description) {
    loading.value = true;
    services
      .query(ref.url, abort.signal)
      .then((preview) => {
        if (!live()) return;
        data.value = {
          ...ref,
          favicon: preview.icon ?? undefined,
          title: preview.title ?? undefined,
          description: preview.description ?? undefined,
        };
        // Metadata enrichment must never outlive its source or acquire a readonly write path.
        if (!services.readonly())
          update({ ...footnote, reference: data.value });
      })
      .catch((error: unknown) => {
        if (!abort.signal.aborted) console.error(error);
      })
      .finally(() => {
        if (!abort.signal.aborted) loading.value = false;
      });
  }
  return {
    getSnapshot: () => snapshot.value,
    subscribe: (listener) => snapshot.subscribe(listener),
    activate: () => {
      const latest = current();
      if (
        abort.signal.aborted ||
        !target.isConnected ||
        !snapshot.value.available ||
        !latest ||
        latest.definitionId !== undefined ||
        !(["type", "url", "docId", "workspaceId", "blobId"] as const).every(
          (key) => latest.reference[key] === ref[key],
        )
      )
        return;
      const resolved = context();
      if (
        ref.type === "doc" &&
        resolved?.access?.readable(resolved.docId).value !== true
      )
        return;
      navigate(
        ref.type === "doc" && resolved
          ? {
              ...footnote,
              reference: {
                ...ref,
                docId: resolved.docId,
                workspaceId: resolved.collection.id,
              },
            }
          : footnote,
        abort,
      );
      abort.abort();
    },
  };
}
