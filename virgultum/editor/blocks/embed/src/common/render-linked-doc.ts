import { getSurfaceBlock } from "@virgultum/block-surface";
import {
  type DocMode,
  ListBlockModel,
  NoteBlockModel,
  NoteDisplayMode,
  ParagraphBlockModel,
} from "@virgultum/model";
import {
  NotificationProvider,
  editorMessage,
  EditorI18nProvider,
  resolveEditorMessage,
} from "@virgultum/shared/services";
import { matchModels } from "@virgultum/shared/utils";
import type { BlockStdScope } from "@virgultum/std";
import {
  type BlockModel,
  type BlockSnapshot,
  type DraftModel,
  Slice,
  type Store,
  Text,
} from "@virgultum/store";

// Throttle delay for block updates to reduce unnecessary re-renders
// - Prevents rapid-fire updates when multiple blocks are updated in quick succession
// - Ensures UI remains responsive while maintaining performance
// - Small enough to feel instant to users, large enough to batch updates effectively
export const RENDER_CARD_THROTTLE_MS = 60;

function filterTextModel(model: BlockModel) {
  if (matchModels(model, [ParagraphBlockModel, ListBlockModel])) {
    return !!model.text?.toString().length;
  }
  return false;
}

export function getNotesFromDoc(doc: Store) {
  const notes = doc.root?.children.filter(
    (child) =>
      matchModels(child, [NoteBlockModel]) &&
      child.props.displayMode !== NoteDisplayMode.EdgelessOnly,
  );

  if (!notes || !notes.length) {
    return null;
  }

  return notes;
}

export function isEmptyDoc(doc: Store | null, mode: DocMode) {
  if (!doc) {
    return true;
  }

  if (mode === "page") {
    const notes = getNotesFromDoc(doc);
    if (!notes || !notes.length) {
      return true;
    }
    return notes.every((note) => isEmptyNote(note));
  } else {
    const surface = getSurfaceBlock(doc);
    if (surface?.elementModels.length || doc.blockSize > 2) {
      return false;
    }
    return true;
  }
}

export function isEmptyNote(note: BlockModel) {
  return note.children.every((block) => {
    return (
      block.flavour === "myoxus:paragraph" &&
      (!block.text || block.text.length === 0)
    );
  });
}

/**
 * Gets the document content with a max length.
 */
export function getDocContentWithMaxLength(doc: Store, maxlength = 500) {
  const notes = getNotesFromDoc(doc);
  if (!notes) return;

  const noteChildren = notes.flatMap((note) =>
    note.children.filter((model) => filterTextModel(model)),
  );
  if (!noteChildren.length) return;

  let count = 0;
  let reached = false;
  const texts = [];

  for (const model of noteChildren) {
    let t = model.text?.toString();
    if (t?.length) {
      const c: number = count + Math.max(0, texts.length - 1);

      if (t.length + c > maxlength) {
        t = t.substring(0, maxlength - c);
        reached = true;
      }

      texts.push(t);
      count += t.length;

      if (reached) {
        break;
      }
    }
  }

  return texts.join("\n");
}

export function getTitleFromSelectedModels(selectedModels: DraftModel[]) {
  const firstBlock = selectedModels[0];
  const isParagraph = (
    model: DraftModel,
  ): model is DraftModel<ParagraphBlockModel> =>
    model.flavour === "myoxus:paragraph";
  if (isParagraph(firstBlock) && firstBlock.props.type.startsWith("h")) {
    return firstBlock.props.text.toString();
  }
  return undefined;
}

export function promptDocTitle(std: BlockStdScope, autofill?: string) {
  const notification = std.getOptional(NotificationProvider);
  if (!notification) return Promise.resolve(undefined);

  return notification.prompt({
    title: resolveEditorMessage(
      editorMessage(
        "com.myoxus.editor.toolbar.create-linked-doc",
        "Create linked doc",
      ),
      std.getOptional(EditorI18nProvider) ?? undefined,
    ),
    message: resolveEditorMessage(
      editorMessage(
        "com.myoxus.editor.linked-doc.title-prompt",
        "Enter a title for the new doc.",
      ),
      std.getOptional(EditorI18nProvider) ?? undefined,
    ),
    placeholder: resolveEditorMessage(
      editorMessage("Untitled", "Untitled"),
      std.getOptional(EditorI18nProvider) ?? undefined,
    ),
    autofill,
    confirmText: resolveEditorMessage(
      editorMessage("Confirm", "Confirm"),
      std.getOptional(EditorI18nProvider) ?? undefined,
    ),
    cancelText: resolveEditorMessage(
      editorMessage("Cancel", "Cancel"),
      std.getOptional(EditorI18nProvider) ?? undefined,
    ),
  });
}

export function notifyDocCreated(std: BlockStdScope) {
  std.getOptional(NotificationProvider)?.notifyWithUndoAction({
    title: resolveEditorMessage(
      editorMessage(
        "com.myoxus.editor.linked-doc.created",
        "Linked doc created",
      ),
      std.getOptional(EditorI18nProvider) ?? undefined,
    ),
    message: resolveEditorMessage(
      editorMessage(
        "com.myoxus.editor.linked-doc.undo-hint",
        "You can click undo to recovery block content",
      ),
      std.getOptional(EditorI18nProvider) ?? undefined,
    ),
    accent: "info",
    duration: 10 * 1000,
  });
}

export async function convertSelectedBlocksToLinkedDoc(
  std: BlockStdScope,
  doc: Store,
  selectedModels: DraftModel[] | Promise<DraftModel[]>,
  docTitle?: string,
) {
  const models = await selectedModels;
  const slice = std.clipboard.sliceToSnapshot(Slice.fromModels(doc, models));
  if (!slice) {
    return;
  }
  const firstBlock = models[0];
  if (!firstBlock) {
    return;
  }
  // if title undefined, use the first heading block content as doc title
  const title = docTitle || getTitleFromSelectedModels(models);
  const linkedDoc = await createLinkedDocFromSlice(
    std,
    doc,
    slice.content,
    title,
  );
  // insert linked doc card
  doc.addSiblingBlocks(
    doc.getBlock(firstBlock.id)!.model,
    [
      {
        flavour: "myoxus:embed-linked-doc",
        pageId: linkedDoc.id,
      },
    ],
    "before",
  );
  // delete selected elements
  models.forEach((model) => doc.deleteBlock(model.id));
  return linkedDoc;
}

export async function createLinkedDocFromSlice(
  std: BlockStdScope,
  doc: Store,
  snapshots: BlockSnapshot[],
  docTitle?: string,
) {
  const _doc = doc.workspace.createDoc();
  const linkedDoc = _doc.getStore();
  linkedDoc.load();
  try {
    const rootId = linkedDoc.addBlock("myoxus:page", {
      title: new Text(docTitle),
    });
    linkedDoc.addBlock("myoxus:surface", {}, rootId);
    const noteId = linkedDoc.addBlock("myoxus:note", {}, rootId);
    // Each transformer can await a different number of nested blocks/assets.
    // Parallel appends reorder siblings; finish each tree before appending the
    // next, and publish the source replacement only after the whole copy exists.
    await std.clipboard.pasteBlockSnapshots(snapshots, linkedDoc, noteId);
  } catch (error) {
    // This target was created solely for this operation and is not linked yet.
    // Discard only that failed target; the caller has not removed source blocks.
    doc.workspace.removeDoc(_doc.id);
    throw error;
  }
  return linkedDoc;
}
