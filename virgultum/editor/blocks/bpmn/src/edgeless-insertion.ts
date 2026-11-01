// SPDX-License-Identifier: AGPL-3.0-or-later
import { DefaultTool } from "@virgultum/block-surface";
import { addNoteAtPoint } from "@virgultum/gfx-note";
import type { IPoint } from "@virgultum/global/gfx";
import { NoteDisplayMode } from "@virgultum/model";
import type { BlockStdScope } from "@virgultum/std";
import { GfxControllerIdentifier } from "@virgultum/std/gfx";
import type * as Y from "yjs";

import {
  type BpmnInsertionResult,
  createBpmnBlockInsertProps,
  insertPreparedBpmnBlockAt,
} from "./commands.js";

/** Native note placement owns the viewport→model conversion and note geometry.
 * BPMN owns only the canonical child. Observers/Undo see one compound insertion;
 * failed readback may remove only this attempt's still-pristine empty note. */
export function insertBpmnEdgelessNote(
  std: BlockStdScope,
  point: IPoint,
  width?: number,
  height?: number,
): BpmnInsertionResult {
  const store = std.store;
  const root = store.root;
  if (
    store.readonly ||
    !root ||
    !Number.isFinite(point.x) ||
    !Number.isFinite(point.y)
  )
    return { ok: false, code: "BPMN_INSERT_CONTEXT", residueRetained: false };
  const props = createBpmnBlockInsertProps();
  const noteId = store.workspace.idGenerator();
  if (!noteId || store.doc.yBlocks.has(noteId))
    return { ok: false, code: "BPMN_INSERT_CONTEXT", residueRetained: false };
  let result: BpmnInsertionResult = {
    ok: false,
    code: "BPMN_INSERT_READBACK",
    residueRetained: false,
  };
  store.captureSync();
  store.transact(() => {
    let pristine: string | undefined;
    try {
      addNoteAtPoint(std, point, {
        id: noteId,
        displayMode: NoteDisplayMode.DocAndEdgeless,
        ...(width === undefined ? {} : { width }),
        ...(height === undefined ? {} : { height }),
      });
      const note = store.doc.yBlocks.get(noteId);
      if (!note) throw new Error("BPMN_INSERT_READBACK");
      pristine = JSON.stringify(note.toJSON());
      result = insertPreparedBpmnBlockAt(store, noteId, props);
    } catch {
      result = {
        ok: false,
        code: "BPMN_INSERT_READBACK",
        residueRetained: store.doc.yBlocks.has(noteId),
      };
    }
    if (!result.ok) {
      const note = store.doc.yBlocks.get(noteId);
      const children = root.yBlock.get("sys:children") as Y.Array<string>;
      const at = children.toArray().indexOf(noteId);
      // A native creation failure can precede its return/readback. No document
      // observers have run inside this outer transaction: its reserved empty
      // root child is still this attempt's residue, not published user content.
      const unchanged =
        pristine === undefined
          ? note?.get("sys:flavour") === "myoxus:note" &&
            (note.get("sys:children") as Y.Array<string>).length === 0 &&
            at >= 0
          : note && JSON.stringify(note.toJSON()) === pristine;
      if (note && unchanged) {
        if (at >= 0) children.delete(at, 1);
        store.doc.yBlocks.delete(noteId);
      }
      result = { ...result, residueRetained: store.doc.yBlocks.has(noteId) };
    }
  });
  store.captureSync();
  if (result.ok) {
    const gfx = std.get(GfxControllerIdentifier);
    gfx.tool.setTool(DefaultTool);
    gfx.selection.set({ elements: [noteId], editing: true });
  }
  return result;
}
