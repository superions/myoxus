// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import type { Store } from "@virgultum/core/store";
import type { EditorHost } from "@virgultum/editor/std";

import { insertFromMarkdown, replaceFromMarkdown } from "../../../utils";
import type { PatchOp } from "./markdown-diff";

/**
 * Applies structured block diff operations against the first note block of a
 * page document, failing closed if the document becomes read-only or detached.
 */
export async function applyPatchToDoc(
  doc: Store,
  patch: PatchOp[],
  host?: EditorHost,
): Promise<void> {
  const notes = doc.getBlocksByFlavour("myoxus:note");
  if (notes.length === 0) return;

  const primaryNote = notes[0].model;
  const initialIds = new Set(primaryNote.children.map((child) => child.id));

  for (const op of patch) {
    if (doc.readonly || !doc.root || !doc.workspace.meta.getDocMeta(doc.id)) {
      throw new Error("Markdown patch destination unavailable");
    }

    if (op.op === "delete") {
      doc.deleteBlock(op.id);
      continue;
    }

    if (op.op === "replace") {
      if (!initialIds.has(op.id)) continue;
      const index = primaryNote.children.findIndex(
        (child) => child.id === op.id,
      );
      if (index === -1) continue;
      await replaceFromMarkdown(
        host,
        op.content,
        doc,
        primaryNote.id,
        index,
        op.id,
      );
      continue;
    }

    await insertFromMarkdown(
      host,
      op.block.content,
      doc,
      primaryNote.id,
      op.index,
      op.block.id,
    );
  }
}
