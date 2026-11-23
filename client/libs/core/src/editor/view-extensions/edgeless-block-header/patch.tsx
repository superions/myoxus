import { JournalService } from "@myoxus/core/modules/journal";
import type { FrameworkProvider } from "@myoxus/infra";
import type { MountReactPortal, ReactToLit } from "@myoxus/lit-react";
import { EmbedSyncedDocConfigExtension } from "@virgultum/editor/blocks/embed-doc";
import { NoteConfigExtension } from "@virgultum/editor/blocks/note";
import { EDGELESS_BLOCK_CHILD_PADDING } from "@virgultum/editor/blocks/root";
import { Bound, Vec } from "@virgultum/editor/global/gfx";
import { DocModeProvider } from "@virgultum/editor/shared/services";
import { GfxControllerIdentifier } from "@virgultum/editor/std/gfx";
import type { DocTitle } from "@virgultum/content/title";

import { VirgultumEditorJournalDocTitle } from "../../virgultum/doc-editor/journal-doc-title";
import { EdgelessEmbedSyncedDocHeader } from "./edgeless-embed-synced-doc-header";
import { EdgelessNoteHeader } from "./edgeless-note-header";

export function patchForEdgelessNoteConfig(
  framework: FrameworkProvider,
  mountPortal: MountReactPortal,
  insidePeekView: boolean,
) {
  return NoteConfigExtension({
    edgelessNoteHeaderVisible: ({ note }) =>
      note.isPageBlock() ||
      (note.children.length === 1 &&
        note.children[0]?.flavour === "myoxus:mermaid"),
    mountEdgelessNoteHeader: (anchor, { note, std }) =>
      mountPortal(anchor, <EdgelessNoteHeader note={note} std={std} />),
    // A sole diagram projects its Source title in the Note header.
    pageBlockTitleVisible: ({ note }) =>
      note.children.length !== 1 ||
      note.children[0]?.flavour !== "myoxus:mermaid",
    mountPageBlockTitle: (anchor, { note }) => {
      const journalService = framework.get(JournalService);
      if (journalService.getJournalDate(note.store.id)) {
        return mountPortal(
          anchor,
          <VirgultumEditorJournalDocTitle page={note.store} />,
        );
      }
      const title = anchor.ownerDocument.createElement("doc-title") as DocTitle;
      title.doc = note.store;
      anchor.append(title);
      return () => title.remove();
    },
    pageBlockViewportFitAnimation: insidePeekView
      ? undefined
      : ({ std, note }) => {
          if (!std.store.root) return false;
          const rootView = std.view.getBlock(std.store.root.id);
          if (!rootView) return false;

          const gfx = std.get(GfxControllerIdentifier);
          const primaryMode = std
            .get(DocModeProvider)
            .getPrimaryMode(std.store.id);

          if (primaryMode !== "page" || !note || note.props.edgeless.collapse) {
            return false;
          }

          // For page-primary docs, edgeless is a secondary view: ALWAYS
          // center on the page block so the user never loses the content
          // behind a stale stored viewport from a prior session.

          const leftPadding = parseInt(
            window
              .getComputedStyle(rootView)
              .getPropertyValue("--myoxus-editor-side-padding")
              .replace("px", ""),
          );
          if (isNaN(leftPadding)) {
            return false;
          }

          let editorWidth = parseInt(
            window
              .getComputedStyle(rootView)
              .getPropertyValue("--myoxus-editor-width")
              .replace("px", ""),
          );
          if (isNaN(editorWidth)) {
            return false;
          }

          const containerWidth = rootView.getBoundingClientRect().width;
          const leftMargin =
            containerWidth > editorWidth
              ? (containerWidth - editorWidth) / 2
              : 0;

          const pageTitleAnchor = gfx.viewport.toModelCoord(
            leftPadding + leftMargin,
            0,
          );

          const noteBound = Bound.deserialize(note.xywh);
          const edgelessTitleAnchor = Vec.add(noteBound.tl, [
            EDGELESS_BLOCK_CHILD_PADDING,
            12,
          ]);

          const center = Vec.sub(edgelessTitleAnchor, pageTitleAnchor);
          gfx.viewport.setCenter(center[0], center[1]);
          gfx.viewport.smoothZoom(0.65, undefined, 15);

          return true;
        },
  });
}

export function patchForEmbedSyncedDocConfig(reactToLit: ReactToLit) {
  return EmbedSyncedDocConfigExtension({
    edgelessHeader: ({ model, std }) =>
      reactToLit(<EdgelessEmbedSyncedDocHeader model={model} std={std} />),
  });
}
