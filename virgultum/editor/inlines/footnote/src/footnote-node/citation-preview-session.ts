// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { computed, signal, type ReadonlySignal } from "@preact/signals-core";
import type { CitationFootNote, FootNote } from "@virgultum/model";
import { ImageProxyService } from "@virgultum/shared/adapters";
import {
  DocDisplayMetaProvider,
  DocEmbedProvider,
  EditorChromeHostIdentifier,
  LinkPreviewServiceIdentifier,
  type EditorCitationState,
} from "@virgultum/shared/services";
import type { BlockStdScope } from "@virgultum/std";
import { html } from "lit";
import type { FootNotePopupClickHandler } from "./footnote-config";

/** The existing hover controller owns positioning; this scope owns access and async work. */
export function renderCitationPreview(
  std: BlockStdScope,
  target: HTMLElement,
  footnote: CitationFootNote,
  current: () => FootNote | null | undefined,
  abort: AbortController,
  navigate: FootNotePopupClickHandler | (() => void),
  update: (value: FootNote) => void,
) {
  const chrome = std.getOptional(EditorChromeHostIdentifier);
  if (!chrome) return html``;
  const ref = footnote.reference;
  const provider = std.getOptional(DocEmbedProvider);
  const workspaceId = ref.workspaceId ?? std.workspace.id;
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
          ? { access: provider, collection: std.workspace, docId: ref.docId }
          : undefined;
  const data = signal(ref);
  const loading = signal(false);
  const live = () =>
    target.isConnected && !abort.signal.aborted && current() === footnote;
  const titles = new Map<string, ReadonlySignal<string>>();
  const localTitle = (docId: string) => {
    let title = titles.get(docId);
    if (!title) {
      title = std.get(DocDisplayMetaProvider).title(docId);
      titles.set(docId, title);
    }
    return title.value;
  };
  const snapshot = computed<EditorCitationState>(() => {
    const resolved = context();
    const readable = resolved?.access?.readable(resolved.docId).value;
    const available =
      ref.type === "doc" ? readable === true : !!(ref.url || ref.fileName);
    const local = resolved?.collection.id === std.workspace.id;
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
          ? std.get(ImageProxyService).buildUrl(data.value.favicon)
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
    std
      .get(LinkPreviewServiceIdentifier)
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
        if (!std.store.readonly) update({ ...footnote, reference: data.value });
      })
      .catch((error: unknown) => {
        if (!abort.signal.aborted) console.error(error);
      })
      .finally(() => {
        if (!abort.signal.aborted) loading.value = false;
      });
  }
  return html`${chrome.renderCitationPreview({
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
  })}`;
}
