import { DisposableGroup } from "@virgultum/global/disposable";
import { deleteTextCommand } from "@virgultum/inline-preset";
import {
  documentReferenceMiddleware,
  pasteMiddleware,
  replaceIdMiddleware,
  surfaceRefToEmbed,
  uploadMiddleware,
} from "@virgultum/shared/adapters";
import {
  clearAndSelectFirstModelCommand,
  deleteSelectedModelsCommand,
  getBlockIndexCommand,
  getBlockSelectionsCommand,
  getImageSelectionsCommand,
  getSelectedModelsCommand,
  getTextSelectionCommand,
  retainFirstModelCommand,
} from "@virgultum/shared/commands";
import type { UIEventHandler } from "@virgultum/std";
import type { BlockSnapshot, Store } from "@virgultum/store";

import { ClipboardConfigExtension } from "./clipboard-config.js";
import { ReadOnlyClipboard } from "./readonly-clipboard";

/**
 * PageClipboard is a class that provides a clipboard for the page root block.
 * It is supported to copy and paste models in the page root block.
 */
export class PageClipboard extends ReadOnlyClipboard {
  static override key = "myoxus-page-clipboard";

  protected _init = () => {
    this._initAdapters();
    const paste = pasteMiddleware(this.std);
    // Use surfaceRefToEmbed middleware to convert surface-ref to embed-linked-doc
    // When pastina a surface-ref block to another doc
    const surfaceRefToEmbedMiddleware = surfaceRefToEmbed(this.std);
    const replaceId = replaceIdMiddleware(this.std.store.workspace.idGenerator);
    const upload = uploadMiddleware(this.std);
    // MarkdownAdapter supplies fresh guarded metadata through the editor scope;
    // a cached workspace inventory is not proof of target read access.
    const documentReferences = documentReferenceMiddleware(
      [],
      new Map(),
      undefined,
      {
        currentDocumentId: this.std.store.id,
      },
    );
    this.std.clipboard.use(paste);
    this.std.clipboard.use(documentReferences);
    this.std.clipboard.use(surfaceRefToEmbedMiddleware);
    this.std.clipboard.use(replaceId);
    this.std.clipboard.use(upload);
    this._disposables.add({
      dispose: () => {
        this.std.clipboard.unuse(paste);
        this.std.clipboard.unuse(documentReferences);
        this.std.clipboard.unuse(surfaceRefToEmbedMiddleware);
        this.std.clipboard.unuse(replaceId);
        this.std.clipboard.unuse(upload);
      },
    });
  };

  onBlockSnapshotPaste = async (
    snapshot: BlockSnapshot,
    doc: Store,
    parent?: string,
    index?: number,
  ) => {
    const block = await this.std.clipboard.pasteBlockSnapshot(
      snapshot,
      doc,
      parent,
      index,
    );
    return block?.id ?? null;
  };

  onPageCut: UIEventHandler = (ctx) => {
    const e = ctx.get("clipboardState").raw;
    e.preventDefault();

    const selection = JSON.stringify(
      this.std.selection.value.map((item) => item.toJSON()),
    );
    const [, { selectedModels = [] }] = this.std.command.exec(
      getSelectedModelsCommand,
      { types: ["block", "text", "image"] },
    );
    using job = this.std.store.getTransformer();
    const captured = selectedModels.map((model) => ({
      model,
      parent: this.std.store.getParent(model)?.id,
      content: JSON.stringify(job.blockToSnapshot(model)),
    }));

    this._copySelectedInPage(() => {
      // Read/asset preparation can outlive the user's selection or concurrent
      // edits. A successful old copy is not permission to delete newer content.
      if (
        !captured.length ||
        this._disposables.disposed ||
        this.std.store.readonly ||
        selection !==
          JSON.stringify(this.std.selection.value.map((item) => item.toJSON()))
      )
        return;
      using current = this.std.store.getTransformer();
      if (
        captured.some(
          ({ model, parent, content }) =>
            this.std.store.getModelById(model.id) !== model ||
            this.std.store.getParent(model)?.id !== parent ||
            JSON.stringify(current.blockToSnapshot(model)) !== content,
        )
      )
        return;
      this.std.command
        .chain()
        .try<{}>((cmd) => [
          cmd.pipe(getTextSelectionCommand).pipe(deleteTextCommand),
          cmd.pipe(getSelectedModelsCommand).pipe(deleteSelectedModelsCommand),
        ])
        .run();
    }).run();
  };

  onPagePaste: UIEventHandler = (ctx) => {
    const e = ctx.get("clipboardState").raw;
    e.preventDefault();

    if (this.std.store.readonly) return;
    const selection = JSON.stringify(
      this.std.selection.value.map((item) => item.toJSON()),
    );
    this.std.clipboard
      .paste(e, this.std.store, undefined, undefined, () => {
        if (
          this.std.store.readonly ||
          selection !==
            JSON.stringify(
              this.std.selection.value.map((item) => item.toJSON()),
            )
        )
          return false;
        return this._preparePasteTarget();
      })
      .catch(console.error);
  };

  /** AI text replacement shares native selection, merge, history and ID owners. */
  pasteText(text: string) {
    const selection = JSON.stringify(
      this.std.selection.value.map((item) => item.toJSON()),
    );
    return this.std.clipboard.pasteText(text, this.std.store, () => {
      if (
        this.std.store.readonly ||
        selection !==
          JSON.stringify(this.std.selection.value.map((item) => item.toJSON()))
      )
        return false;
      return this._preparePasteTarget();
    });
  }

  private _preparePasteTarget() {
    // Selection deletion is synchronous and only follows successful adapter
    // preparation. Target loads must not erase content or paste at a stale caret.
    this.std.store.captureSync();
    let target: { parent?: string; index?: number } | undefined;
    this.std.command
      .chain()
      .try<{}>((cmd) => [
        cmd.pipe(getTextSelectionCommand).pipe((ctx, next) => {
          const { currentTextSelection } = ctx;
          if (!currentTextSelection) {
            return;
          }
          const { from, to } = currentTextSelection;
          if (to && from.blockId !== to.blockId) {
            this.std.command.exec(deleteTextCommand, {
              currentTextSelection,
            });
          }
          return next();
        }),
        cmd
          .pipe(getSelectedModelsCommand)
          .pipe(clearAndSelectFirstModelCommand)
          .pipe(retainFirstModelCommand)
          .pipe(deleteSelectedModelsCommand),
      ])
      .try<{ currentSelectionPath: string }>((cmd) => [
        cmd.pipe(getTextSelectionCommand).pipe((ctx, next) => {
          const textSelection = ctx.currentTextSelection;
          if (!textSelection) {
            return;
          }
          next({ currentSelectionPath: textSelection.from.blockId });
        }),
        cmd.pipe(getBlockSelectionsCommand).pipe((ctx, next) => {
          const currentBlockSelections = ctx.currentBlockSelections;
          if (!currentBlockSelections) {
            return;
          }
          const blockSelection = currentBlockSelections.at(-1);
          if (!blockSelection) {
            return;
          }
          next({ currentSelectionPath: blockSelection.blockId });
        }),
        cmd.pipe(getImageSelectionsCommand).pipe((ctx, next) => {
          const currentImageSelections = ctx.currentImageSelections;
          if (!currentImageSelections) {
            return;
          }
          const imageSelection = currentImageSelections.at(-1);
          if (!imageSelection) {
            return;
          }
          next({ currentSelectionPath: imageSelection.blockId });
        }),
      ])
      .pipe(getBlockIndexCommand)
      .pipe((ctx, next) => {
        if (!ctx.parentBlock) {
          return;
        }
        target = {
          parent: ctx.parentBlock.model.id,
          index: ctx.blockIndex !== undefined ? ctx.blockIndex + 1 : 1,
        };

        return next();
      })
      .run();

    if (target) return target;

    // If no valid selection target exists (for example, stale block selection
    // right after cut), create/focus the default paragraph and paste after it.
    const firstParagraphId = document
      .querySelector("myoxus-page-root")
      ?.focusFirstParagraph?.()?.id;
    const parentModel = firstParagraphId
      ? this.std.store.getParent(firstParagraphId)
      : null;
    // An editing Edgeless Note can have no Page caret or Page root. Without
    // a resolved parent, reject paste rather than insert a child at the root.
    if (!parentModel) return false;
    const paragraphIndex =
      firstParagraphId && parentModel
        ? parentModel.children.findIndex(
            (child) => child.id === firstParagraphId,
          )
        : -1;
    const insertIndex = paragraphIndex >= 0 ? paragraphIndex + 1 : undefined;

    return { parent: parentModel.id, index: insertIndex };
  }

  override mounted() {
    if (this._disposables.disposed) {
      this._disposables = new DisposableGroup();
    }
    // Duplicate/insert actions need Note unwrapping and ID remapping on HTTP
    // too; they never access the OS clipboard.
    this._init();
    const clipboardConfig = this.std.getOptional(
      ClipboardConfigExtension.identifier,
    );
    const httpFallback = clipboardConfig?.httpFallback ?? false;
    if (!navigator.clipboard && !httpFallback) {
      // Clipboard API requires a secure context (HTTPS). If the admin has
      // enabled `client.clipboardHttpFallback` the execCommand path is used
      // instead; otherwise degrade gracefully.
      console.debug(
        "navigator.clipboard is not available. Enable clipboardHttpFallback in admin settings to use execCommand fallback over HTTP.",
      );
      return;
    }
    this._disposables.add(this.std.event.add("copy", this.onPageCopy));
    this._disposables.add(this.std.event.add("paste", this.onPagePaste));
    this._disposables.add(this.std.event.add("cut", this.onPageCut));
  }
}
