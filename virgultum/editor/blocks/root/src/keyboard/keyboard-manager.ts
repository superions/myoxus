import {
  convertSelectedBlocksToLinkedDoc,
  getTitleFromSelectedModels,
  notifyDocCreated,
  promptDocTitle,
} from "@virgultum/block-embed";
import { ParagraphBlockComponent } from "@virgultum/block-paragraph";
import { IS_MAC } from "@virgultum/global/env";
import { NoteBlockModel, ParagraphBlockModel } from "@virgultum/model";
import {
  draftSelectedModelsCommand,
  getSelectedModelsCommand,
} from "@virgultum/shared/commands";
import {
  hasMyoxusEditorLocalKeyboardTarget,
  matchModels,
} from "@virgultum/shared/utils";
import {
  type BlockComponent,
  BlockSelection,
  type UIEventHandler,
} from "@virgultum/std";
import { toDraftModel } from "@virgultum/store";

export class PageKeyboardManager {
  private readonly _handleDelete: UIEventHandler = (ctx) => {
    const event = ctx.get("defaultState").event;
    if (hasMyoxusEditorLocalKeyboardTarget(event)) return;
    const blockSelections = this._currentSelection.filter((sel) =>
      sel.is(BlockSelection),
    );
    if (blockSelections.length === 0) {
      return;
    }

    event.preventDefault();

    const deletedBlocks: string[] = [];
    blockSelections.forEach((sel) => {
      const id = sel.blockId;
      const block = this._doc.getBlock(id);
      if (!block) return;
      const model = block.model;

      if (
        matchModels(model, [ParagraphBlockModel]) &&
        model.props.type.startsWith("h") &&
        model.props.collapsed
      ) {
        const component = this.rootComponent.host.view.getBlock(id);
        if (!(component instanceof ParagraphBlockComponent)) return;
        const collapsedSiblings = component.collapsedSiblings;

        deletedBlocks.push(
          ...[id, ...collapsedSiblings.map((sibling) => sibling.id)].filter(
            (id) => !deletedBlocks.includes(id),
          ),
        );
      } else {
        deletedBlocks.push(id);
      }
    });

    this._doc.transact(() => {
      deletedBlocks.forEach((id) => {
        const block = this._doc.getBlock(id);
        if (block) {
          this._doc.deleteBlock(block.model);
        }
      });

      this._selection.clear(["block", "text"]);
    });
  };

  private get _currentSelection() {
    return this._selection.value;
  }

  private get _doc() {
    return this.rootComponent.store;
  }

  private get _selection() {
    return this.rootComponent.host.selection;
  }

  constructor(public rootComponent: BlockComponent) {
    const redo: UIEventHandler = (ctx) => {
      ctx.get("defaultState").event.preventDefault();
      if (this._doc.canRedo) {
        this._doc.redo();
      }
      // A handled shifted shortcut must not fall through to the unshifted
      // Mod-z binding and immediately undo the redo it just performed.
      return true;
    };
    const redoOnNonMacCtrlY: UIEventHandler = (ctx) => {
      // Keep macOS on the native Mod-Shift-Z redo path, but support Ctrl+Y on
      // Windows and Linux where users and browser tests expect it to mirror
      // common desktop-editor redo behaviour. The hotkey dispatcher normalizes
      // the Control modifier as `Ctrl`, and some browser automation paths keep
      // the produced key uppercase even without Shift.
      if (IS_MAC) return;
      return redo(ctx);
    };

    this.rootComponent.bindHotKey(
      {
        "Mod-z": (ctx) => {
          ctx.get("defaultState").event.preventDefault();

          if (this._doc.canUndo) {
            this._doc.undo();
          }
          return true;
        },
        "Shift-Mod-z": redo,
        "Shift-Mod-Z": redo,
        "Ctrl-y": redoOnNonMacCtrlY,
        "Ctrl-Y": redoOnNonMacCtrlY,
        "Mod-y": redoOnNonMacCtrlY,
        "Mod-Y": redoOnNonMacCtrlY,
        "Mod-Backspace": () => true,
        Backspace: this._handleDelete,
        Delete: this._handleDelete,
        "Control-d": (ctx) => {
          if (!IS_MAC) return;
          this._handleDelete(ctx);
        },
        "Mod-Shift-l": () => {
          this._createEmbedBlock();
        },
      },
      {
        global: true,
      },
    );
  }

  private _createEmbedBlock() {
    const rootComponent = this.rootComponent;
    const [_, ctx] = this.rootComponent.std.command
      .chain()
      .pipe(getSelectedModelsCommand, {
        types: ["block"],
        mode: "highest",
      })
      .pipe(draftSelectedModelsCommand)
      .run();
    const selectedModels = ctx.selectedModels?.filter(
      (block) =>
        !block.flavour.startsWith("myoxus:embed-") &&
        matchModels(doc.getParent(block), [NoteBlockModel]),
    );

    const draftedModels = ctx.draftedModels;
    if (!selectedModels?.length || !draftedModels) {
      return;
    }

    const doc = rootComponent.host.store;
    const autofill = getTitleFromSelectedModels(
      selectedModels.map(toDraftModel),
    );
    promptDocTitle(rootComponent.std, autofill)
      .then((title) => {
        if (title === null) return;
        convertSelectedBlocksToLinkedDoc(
          this.rootComponent.std,
          doc,
          draftedModels,
          title,
        ).catch(console.error);
        notifyDocCreated(rootComponent.std);
      })
      .catch(console.error);
  }
}
