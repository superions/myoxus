// SPDX-License-Identifier: AGPL-3.0-or-later

import { waitForTaskReferenceOperation } from "./task-reference-operation";
import { DocsService } from "@myoxus/core/modules/doc";
import { DocumentMetadataCacheService } from "@myoxus/core/modules/document-metadata/services/document-metadata-cache";
import { GuardService } from "@myoxus/core/modules/permissions";
import { WorkspaceServerService } from "@myoxus/core/modules/server";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import { DatabaseReferenceBlockModel } from "@virgultum/block-database/reference-store";
import type { FrameworkProvider } from "@myoxus/infra";
import { TextSelection, type BlockStdScope } from "@virgultum/editor/std";
import { addNoteAtPoint } from "@virgultum/editor/gfx/note";
import { GfxControllerIdentifier } from "@virgultum/editor/std/gfx";
import { Bound, Point } from "@virgultum/editor/global/gfx";
import { DEFAULT_NOTE_OFFSET_Y } from "@virgultum/editor/blocks/surface";
import { NoteBlockModel, NoteDisplayMode } from "@virgultum/editor/model";
import type { BlockModel } from "@virgultum/editor/store";
import { DocModeProvider } from "@virgultum/editor/shared/services";

export type TaskReferenceTarget = {
  workspaceId: string;
  databaseId: string;
  rowId: string;
};
export type TaskReferenceSource = {
  sourceDocumentId: string;
  sourceExternalId: string;
  blockId: string;
  selectionAnchor?: string | null;
};
export type TaskReferenceInsertionState =
  "inserted" | "readonly" | "failed" | "uncertain";
type Intent = {
  blockId: string;
  noteId?: string;
  target: TaskReferenceTarget;
  written: boolean;
  confirmed: boolean;
  busy: boolean;
};
const intents = new Map<string, Intent>();

/** Resolve the last frozen selection endpoint to its direct Note child. Never
 * use the current editor selection or insert a Database block inside a list.
 */
export function taskReferencePlacement(
  std: BlockStdScope,
  source: Pick<TaskReferenceSource, "blockId" | "selectionAnchor">,
) {
  let ids = [source.blockId];
  let noteId: string | undefined;
  if (source.selectionAnchor) {
    try {
      const anchor = JSON.parse(source.selectionAnchor);
      const selection = TextSelection.fromJSON(anchor);
      noteId = typeof anchor.noteId === "string" ? anchor.noteId : undefined;
      ids = [
        source.blockId,
        selection.from.blockId,
        ...(selection.to ? [selection.to.blockId] : []),
      ];
      for (const point of [selection.from, selection.to]) {
        if (!point) continue;
        const model = std.store.getBlock(point.blockId)?.model;
        if (
          !model?.text ||
          point.index < 0 ||
          point.length < 0 ||
          point.index + point.length > model.text.length
        )
          return null;
      }
    } catch {
      return null;
    }
  }
  let note: BlockModel | null = null;
  let index = -1;
  for (const id of new Set(ids)) {
    let child = std.store.getBlock(id)?.model;
    if (!child) return null;
    const visited = new Set<string>();
    let parent = std.store.getParent(child);
    while (parent && parent.flavour !== "myoxus:note") {
      if (visited.has(parent.id)) return null;
      visited.add(parent.id);
      child = parent;
      parent = std.store.getParent(child);
    }
    if (
      !parent ||
      (note && note.id !== parent.id) ||
      (noteId && parent.id !== noteId)
    )
      return null;
    const position = parent.children.findIndex(
      (model) => model.id === child!.id,
    );
    if (position < 0) return null;
    note = parent;
    index = Math.max(index, position);
  }
  return note ? { parent: note, index: index + 1 } : null;
}

/** One primitive block identity survives a lost editor acknowledgement. Live
 * editor/framework callbacks are never retained alongside insertion intents.
 */
export function createTaskReferenceInserter(
  framework: FrameworkProvider,
  std: BlockStdScope,
  openingOwnerIdentity: string,
) {
  const capturedMode = (source: TaskReferenceSource) => {
    if (!source.selectionAnchor) return "page";
    try {
      const anchor = JSON.parse(source.selectionAnchor);
      TextSelection.fromJSON(anchor);
      if (anchor.captureMode === undefined && anchor.noteId === undefined)
        return "page";
      if (
        (anchor.captureMode !== "page" && anchor.captureMode !== "edgeless") ||
        typeof anchor.noteId !== "string" ||
        !anchor.noteId
      )
        return null;
      return anchor.captureMode;
    } catch {
      return null;
    }
  };
  const fence = (source: TaskReferenceSource, target: TaskReferenceTarget) => {
    const server = framework.get(WorkspaceServerService).server;
    const metadata = framework.get(DocumentMetadataCacheService);
    const docId =
      metadata.getModel(source.sourceExternalId)?.metadata.docId ??
      metadata.getIndexRowByExternalId(source.sourceExternalId)?.docId;
    return (
      std.host.isConnected &&
      server &&
      JSON.stringify([
        server.id,
        server.baseUrl,
        server.account$.value?.id,
        std.workspace.id,
      ]) === openingOwnerIdentity &&
      std.store.doc.id === source.sourceExternalId &&
      docId === source.sourceDocumentId &&
      target.workspaceId === std.workspace.id &&
      std.get(DocModeProvider).getEditorMode() === capturedMode(source)
    );
  };
  const owned = new Set<string>();
  const insert = async (
    key: string,
    target: TaskReferenceTarget,
    source: TaskReferenceSource,
  ): Promise<TaskReferenceInsertionState> => {
    if (!fence(source, target)) return "failed";
    const owner = JSON.stringify([
      openingOwnerIdentity,
      source.sourceDocumentId,
      key,
    ]);
    let intent = intents.get(owner);
    if (!intent) {
      if (intents.size >= 128) return "failed";
      intent = {
        blockId: std.store.doc.workspace.idGenerator(),
        target: { ...target },
        written: false,
        confirmed: false,
        busy: false,
      };
      intents.set(owner, intent);
      owned.add(owner);
    }
    owned.add(owner);
    if (JSON.stringify(intent.target) !== JSON.stringify(target))
      return "failed";
    if (intent.busy) return "uncertain";
    intent.busy = true;
    const signal = AbortSignal.timeout(10_000);
    let ref: ReturnType<DocsService["open"]> = null;
    try {
      if (std.store.readonly) {
        if (!intent.written) intents.delete(owner);
        return "readonly";
      }
      const initiallyPermitted = await waitForTaskReferenceOperation(
        framework.get(GuardService).can("Doc_Update", source.sourceExternalId),
        signal,
      );
      if (!fence(source, target)) return "failed";
      if (!initiallyPermitted) {
        if (!intent.written) intents.delete(owner);
        return "readonly";
      }
      ref = framework.get(DocsService).open(source.sourceExternalId);
      if (!ref || ref.doc.yDoc !== std.store.doc.spaceDoc) return "failed";
      await ref.doc.waitForSyncReady(signal);
      if (!fence(source, target)) return "failed";
      await framework
        .get(WorkspaceService)
        .workspace.engine.doc.waitForSynced(source.sourceExternalId, signal);
      if (!fence(source, target)) return "failed";
      signal.throwIfAborted();
      const existing = std.store.getBlock(intent.blockId)?.model;
      if (existing) {
        if (
          !(existing instanceof DatabaseReferenceBlockModel) ||
          existing.props.serverWorkspaceId !== target.workspaceId ||
          existing.props.serverDatabaseId !== target.databaseId ||
          existing.props.serverRowId !== target.rowId
        )
          return "failed";
        intent.confirmed = true;
        return "inserted";
      }
      // A confirmed insertion later removed by Undo/deletion is not a retry.
      if (intent.written) return "failed";
      const permission = framework
        .get(GuardService)
        .can("Doc_Update", source.sourceExternalId);
      const permitted = await waitForTaskReferenceOperation(permission, signal);
      signal.throwIfAborted();
      if (!fence(source, target)) return "failed";
      if (!permitted || std.store.readonly) {
        if (!intent.written) intents.delete(owner);
        return "readonly";
      }
      const placement = taskReferencePlacement(std, source);
      if (!placement) return "failed";
      std.store.captureSync();
      // One Yjs history item owns only the reference and its new ordinary Note.
      // The source sticky is never resized, restyled or rewritten.
      // Native Store writes materialize the new parent between operations.
      let parent = placement.parent;
      let index = placement.index;
      if (capturedMode(source) === "edgeless") {
        const sourceNote = placement.parent;
        if (!(sourceNote instanceof NoteBlockModel))
          throw new Error("Source Note unavailable");
        const xywh = sourceNote.props.xywh;
        if (typeof xywh !== "string")
          throw new Error("Source Note unavailable");
        const bound = Bound.deserialize(xywh);
        if (
          ![bound.x, bound.y, bound.w, bound.h].every(Number.isFinite) ||
          bound.w <= 0 ||
          bound.h <= 0
        )
          throw new Error("Source Note unavailable");
        intent.noteId ??= std.store.doc.workspace.idGenerator();
        const existingNote = std.store.getBlock(intent.noteId)?.model;
        if (existingNote && existingNote.flavour !== "myoxus:note")
          throw new Error("Reference Note unavailable");
        if (!existingNote) {
          const viewport = std.get(GfxControllerIdentifier).viewport;
          const [x, y] = viewport.toViewCoord(
            bound.x,
            bound.y + bound.h + DEFAULT_NOTE_OFFSET_Y,
          );
          addNoteAtPoint(std, new Point(x, y), {
            id: intent.noteId,
            displayMode: NoteDisplayMode.DocAndEdgeless,
            offsetX: 0,
            offsetY: 0,
          });
        }
        const note = std.store.getBlock(intent.noteId)?.model;
        if (!note) throw new Error("Reference Note unavailable");
        parent = note;
        index = 0;
      }
      std.store.addBlock(
        "myoxus:database",
        {
          id: intent.blockId,
          serverWorkspaceId: target.workspaceId,
          serverDatabaseId: target.databaseId,
          serverRowId: target.rowId,
          serverViewId: null,
        },
        parent,
        index,
      );
      std.store.captureSync();
      intent.written = true;
      await framework
        .get(WorkspaceService)
        .workspace.engine.doc.waitForSynced(source.sourceExternalId, signal);
      if (!fence(source, target)) return "failed";
      signal.throwIfAborted();
      intent.confirmed = true;
      return "inserted";
    } catch {
      return "uncertain";
    } finally {
      intent.busy = false;
      ref?.release();
    }
  };
  return Object.assign(insert, {
    releaseConfirmed: (requestId?: string) => {
      for (const owner of owned)
        if (
          intents.get(owner)?.confirmed &&
          (!requestId || JSON.parse(owner)[2] === requestId)
        )
          intents.delete(owner);
    },
  });
}
