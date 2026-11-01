// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  hasCapability,
  MyoxusHostCapability,
  MyoxusHostServiceIdentifier,
} from "@virgultum/shared/services";
import { type BlockStdScope, BlockSelection } from "@virgultum/std";
import { GfxControllerIdentifier } from "@virgultum/std/gfx";

/** All block/menu entry points dispatch the same identity-bound workspace request. */
export async function requestBpmnEditor(std: BlockStdScope, blockId: string) {
  const host = std.getOptional(MyoxusHostServiceIdentifier);
  if (
    !host ||
    !hasCapability(host, MyoxusHostCapability.BpmnEditorSession) ||
    !host.openBpmnEditor
  )
    throw new Error("BPMN_SESSION_UNAVAILABLE");
  const editorHostId = (std.host.dataset.myoxusBpmnHostId ??=
    crypto.randomUUID());
  const editorHost = std.host;
  const origin = std.view.getBlock(blockId);
  const originatingNoteId = origin?.closest("myoxus-edgeless-note")
    ? std.store.getParent(blockId)?.id
    : undefined;
  const result = await host.openBpmnEditor({
    workspaceId: std.workspace.id,
    docId: std.store.id,
    blockId,
    editorHostId,
  });
  // Slash insertion and an existing block's Open share the same return target.
  // Never refocus a host which has been detached by navigation/workspace change.
  if (editorHost.isConnected) {
    const block = std.view.getBlock(blockId);
    if (block?.isConnected) {
      std.selection.set([std.selection.create(BlockSelection, { blockId })]);
      // Native notes mask child controls outside editing selection. Restore the
      // originating note before block focus so Open/retry remains operable.
      const note = block.closest("myoxus-edgeless-note");
      const parent = std.store.getParent(block.model);
      if (note && parent)
        std.getOptional(GfxControllerIdentifier)?.selection.set({
          elements: [parent.id],
          editing: true,
        });
      block.focus({ preventScroll: true });
    } else {
      // Deletion must not return keyboard focus to BODY or recreate the removed
      // block. Its surviving native note remains a selection target, not an edit.
      std.selection.clear();
      if (originatingNoteId && std.store.getBlock(originatingNoteId))
        std.getOptional(GfxControllerIdentifier)?.selection.set({
          elements: [originatingNoteId],
          editing: false,
        });
      editorHost.focus({ preventScroll: true });
    }
  }
  return result;
}
