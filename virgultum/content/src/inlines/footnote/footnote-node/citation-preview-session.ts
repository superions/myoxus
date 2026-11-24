// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FootNote, CitationFootNote } from "@virgultum/core/models";
import { ImageProxyService } from "@virgultum/core/adapters";
import {
  DocDisplayMetaProvider,
  DocEmbedProvider,
  LinkPreviewServiceIdentifier,
} from "@virgultum/core/services";
import type { BlockStdScope } from "@virgultum/core/runtime";
import { citationControls } from "../citation-controls";
import type { FootNotePopupClickHandler } from "./footnote-config";

export function createCitationPreviewControls(
  std: BlockStdScope,
  target: HTMLElement,
  footnote: CitationFootNote,
  current: () => FootNote | null | undefined,
  abort: AbortController,
  navigate: FootNotePopupClickHandler,
  update: (value: FootNote) => void,
) {
  return citationControls(
    {
      workspace: std.workspace,
      provider: std.getOptional(DocEmbedProvider),
      title: (id) => std.get(DocDisplayMetaProvider).title(id),
      image: (url) => std.get(ImageProxyService).buildUrl(url),
      query: (url, signal) =>
        std.get(LinkPreviewServiceIdentifier).query(url, signal),
      readonly: () => std.store.readonly,
    },
    target,
    footnote,
    current,
    abort,
    navigate,
    update,
  );
}
