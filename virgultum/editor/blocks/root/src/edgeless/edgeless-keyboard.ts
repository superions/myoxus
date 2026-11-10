import { editorMessage } from "@virgultum/shared/services";
import { insertLinkByQuickSearchCommand } from "@virgultum/block-bookmark";
import { EdgelessTextBlockComponent } from "@virgultum/block-edgeless-text";
import { FrameTool, type PresentToolOption } from "@virgultum/block-frame";
import {
  DefaultTool,
  EdgelessLegacySlotIdentifier,
  isNoteBlock,
} from "@virgultum/block-surface";
import { BrushTool, EraserTool, HighlighterTool } from "@virgultum/gfx-brush";
import {
  ConnectorTool,
  mountConnectorLabelEditor,
} from "@virgultum/gfx-connector";
import {
  createGroupFromSelectedCommand,
  ungroupCommand,
} from "@virgultum/gfx-group";
import { NoteTool } from "@virgultum/gfx-note";
import { PanTool } from "@virgultum/gfx-pointer";
import { ShapeTool } from "@virgultum/gfx-shape";
import { TextTool } from "@virgultum/gfx-text";
import { IS_MAC } from "@virgultum/global/env";
import { Bound, getCommonBound } from "@virgultum/global/gfx";
import {
  ConnectorElementModel,
  type ConnectorMode,
  EdgelessTextBlockModel,
  GroupElementModel,
  NoteBlockModel,
  NoteDisplayMode,
} from "@virgultum/model";
import { EditPropsStore, TelemetryProvider } from "@virgultum/shared/services";
import {
  editorToast,
  hasMyoxusEditorLocalKeyboardTarget,
  hasOpenMyoxusUiOverlay,
  hasTextControlEventTarget,
  matchModels,
  wasMyoxusEditorEscapeConsumed,
} from "@virgultum/shared/utils";
import { SurfaceSelection, TextSelection } from "@virgultum/std";
import {
  type BaseTool,
  GfxBlockElementModel,
  GfxControllerIdentifier,
  InteractivityIdentifier,
  isGfxGroupCompatibleModel,
  type ToolOptions,
  type ToolType,
} from "@virgultum/std/gfx";

import { PageKeyboardManager } from "../keyboard/keyboard-manager.js";
import type { EdgelessRootBlockComponent } from "./edgeless-root-block.js";
import {
  DEFAULT_NOTE_CHILD_FLAVOUR,
  DEFAULT_NOTE_CHILD_TYPE,
  DEFAULT_NOTE_TIP,
} from "./utils/consts.js";
import { deleteElements } from "./utils/crud.js";
import { isCanvasElement } from "./utils/query.js";

export class EdgelessPageKeyboardManager extends PageKeyboardManager {
  get gfx() {
    return this.std.get(GfxControllerIdentifier);
  }

  get slots() {
    return this.std.get(EdgelessLegacySlotIdentifier);
  }

  get std() {
    return this.rootComponent.std;
  }

  constructor(override rootComponent: EdgelessRootBlockComponent) {
    super(rootComponent);
    this.rootComponent.bindHotKey(
      {
        v: () => {
          this._setEdgelessTool(DefaultTool);
        },
        t: () => {
          this._setEdgelessTool(TextTool);
        },
        c: () => {
          const editPropsStore = this.std.get(EditPropsStore);

          let mode: ConnectorMode;
          if (
            this.gfx.tool.currentToolName$.peek() === ConnectorTool.toolName
          ) {
            mode = this.gfx.tool.get(ConnectorTool).getNextMode();
            editPropsStore.recordLastProps("connector", { mode });
          } else {
            mode = editPropsStore.lastProps$.peek().connector.mode;
          }

          this._setEdgelessTool(ConnectorTool, { mode });
        },
        h: () => {
          this._setEdgelessTool(PanTool, {
            panning: false,
          });
        },
        n: () => {
          this._setEdgelessTool(NoteTool, {
            childFlavour: DEFAULT_NOTE_CHILD_FLAVOUR,
            childType: DEFAULT_NOTE_CHILD_TYPE,
            tip: DEFAULT_NOTE_TIP,
          });
        },
        p: () => {
          this._setEdgelessTool(BrushTool);
        },
        "Shift-p": () => {
          this._setEdgelessTool(HighlighterTool);
        },
        e: () => {
          this._setEdgelessTool(EraserTool);
        },
        k: () => {
          if (this.rootComponent.service.locked) return;
          const { selection } = rootComponent.service;

          if (
            selection.selectedElements.length === 1 &&
            selection.firstElement instanceof GfxBlockElementModel &&
            matchModels(selection.firstElement as GfxBlockElementModel, [
              NoteBlockModel,
            ])
          ) {
            this.slots.toggleNoteSlicer.next();
          }
        },
        f: () => {
          if (this.rootComponent.service.locked) return;
          if (
            this.rootComponent.service.selection.selectedElements.length !==
              0 &&
            !this.rootComponent.service.selection.editing
          ) {
            const frame = rootComponent.service.frame.createFrameOnSelected();
            if (!frame) return;
            this.rootComponent.std
              .getOptional(TelemetryProvider)
              ?.track("CanvasElementAdded", {
                control: "shortcut",
                page: "whiteboard editor",
                module: "toolbar",
                segment: "toolbar",
                type: "frame",
              });
            rootComponent.surface.fitToViewport(Bound.deserialize(frame.xywh));
          } else if (!this.rootComponent.service.selection.editing) {
            this._setEdgelessTool(FrameTool);
          }
        },
        "-": () => {
          if (this.rootComponent.service.locked) return;
          const { selectedElements: elements } =
            rootComponent.service.selection;
          if (
            !rootComponent.service.selection.editing &&
            elements.length === 1 &&
            isNoteBlock(elements[0])
          ) {
            this.slots.toggleNoteSlicer.next();
          }
        },
        "@": () => {
          const std = this.rootComponent.std;
          if (
            std.selection.getGroup("note").length > 0 ||
            std.selection.find(TextSelection) ||
            Boolean(std.selection.find(SurfaceSelection)?.editing)
          ) {
            return;
          }
          const [_, { insertedLinkType }] = std.command.exec(
            insertLinkByQuickSearchCommand,
          );

          insertedLinkType
            ?.then((type) => {
              const flavour = type?.flavour;
              if (!flavour) return;

              rootComponent.std
                .getOptional(TelemetryProvider)
                ?.track("CanvasElementAdded", {
                  control: "shortcut",
                  page: "whiteboard editor",
                  module: "toolbar",
                  segment: "toolbar",
                  type: flavour.split(":")[1],
                });
            })
            .catch(console.error);
        },
        "Shift-s": () => {
          if (this.rootComponent.service.locked) return;
          const controller = rootComponent.gfx.tool.currentTool$.peek();
          if (
            this.rootComponent.service.selection.editing ||
            !(controller instanceof ShapeTool)
          ) {
            return;
          }
          this._setEdgelessTool(ShapeTool, {
            shapeName: controller.cycleShapeName("prev"),
          });

          controller.createOverlay();
        },
        "Mod-g": (ctx) => {
          if (this.rootComponent.service.locked) return;
          if (
            this.rootComponent.service.selection.selectedElements.length > 1 &&
            !this.rootComponent.service.selection.editing
          ) {
            ctx.get("keyboardState").event.preventDefault();
            rootComponent.std.command.exec(createGroupFromSelectedCommand);
          }
        },
        "Shift-Mod-g": (ctx) => {
          if (this.rootComponent.service.locked) return;
          const { selection } = this.rootComponent.service;
          if (
            selection.selectedElements.length === 1 &&
            selection.firstElement instanceof GroupElementModel &&
            !selection.firstElement.isLocked()
          ) {
            ctx.get("keyboardState").event.preventDefault();
            rootComponent.std.command.exec(ungroupCommand, {
              group: selection.firstElement,
            });
          }
        },
        "Mod-a": (ctx) => {
          if (hasTextControlEventTarget(ctx.get("keyboardState").raw)) return;
          if (this.rootComponent.service.locked) return;
          if (this.rootComponent.service.selection.editing) {
            return;
          }

          ctx.get("defaultState").event.preventDefault();
          const { service } = this.rootComponent;
          this.rootComponent.service.selection.set({
            elements: [
              ...service.blocks
                .filter(
                  (block) =>
                    block.group === null &&
                    !(
                      matchModels(block, [NoteBlockModel]) &&
                      block.props.displayMode === NoteDisplayMode.DocOnly
                    ),
                )
                .map((block) => block.id),
              ...service.elements
                .filter((el) => el.group === null)
                .map((el) => el.id),
            ],
            editing: false,
          });
        },
        "Mod--": (ctx) => {
          ctx.get("defaultState").event.preventDefault();
          this.rootComponent.service.setZoomByAction("out");
        },
        "Alt-0": (ctx) => {
          ctx.get("defaultState").event.preventDefault();
          this.rootComponent.service.setZoomByAction("reset");
        },
        "Alt-1": (ctx) => {
          ctx.get("defaultState").event.preventDefault();
          this.rootComponent.service.setZoomByAction("fit");
        },
        "Alt-2": (ctx) => {
          ctx.get("defaultState").event.preventDefault();

          const selectedElements = this.gfx.selection.selectedElements;

          if (selectedElements.length === 0) {
            return;
          }

          const bound = getCommonBound(selectedElements);
          if (bound === null) {
            return;
          }

          editorToast(
            this.rootComponent.host,
            editorMessage(
              "com.myoxus.editor.canvas.zoom-to-selection",
              "Zoom to selection",
            ),
          );

          this.gfx.viewport.setViewportByBound(
            bound,
            [0.12, 0.12, 0.12, 0.12],
            true,
          );
        },
        "Mod-=": (ctx) => {
          ctx.get("defaultState").event.preventDefault();
          this.rootComponent.service.setZoomByAction("in");
        },
        Backspace: (ctx) => {
          if (hasMyoxusEditorLocalKeyboardTarget(ctx.get("keyboardState").raw))
            return;
          this._delete();
        },
        Delete: (ctx) => {
          if (hasMyoxusEditorLocalKeyboardTarget(ctx.get("keyboardState").raw))
            return;
          this._delete();
        },
        "Control-d": () => {
          if (!IS_MAC) return;
          this._delete();
        },
        Escape: (ctx) => {
          const event = ctx.get("keyboardState").raw;
          if (hasOpenMyoxusUiOverlay(event)) {
            return;
          }
          // Global hotkeys run before an embedded editor's local keydown
          // owner. Defer only the selection fallback until that synchronous
          // event path has had a chance to consume Escape. An open Note then
          // returns to its outer selection instead of being deselected in the
          // same keypress that clears an inner editor state.
          queueMicrotask(() => {
            if (wasMyoxusEditorEscapeConsumed(event)) return;
            const selection = this.rootComponent.service.selection;
            if (selection.empty) return;
            if (
              selection.editing &&
              selection.selectedElements.length === 1 &&
              isNoteBlock(selection.selectedElements[0])
            ) {
              selection.set({
                editing: false,
                elements: [selection.selectedElements[0].id],
              });
              return;
            }
            rootComponent.selection.clear();
          });
        },

        ArrowUp: () => {
          this._move("ArrowUp");
        },

        ArrowDown: () => {
          this._move("ArrowDown");
        },

        ArrowLeft: () => {
          this._move("ArrowLeft");
        },

        ArrowRight: () => {
          this._move("ArrowRight");
        },

        "Shift-ArrowUp": () => {
          this._move("ArrowUp", true);
        },

        "Shift-ArrowDown": () => {
          this._move("ArrowDown", true);
        },

        "Shift-ArrowLeft": () => {
          this._move("ArrowLeft", true);
        },

        "Shift-ArrowRight": () => {
          this._move("ArrowRight", true);
        },

        Enter: () => {
          const { service } = rootComponent;
          const selection = service.selection;
          const elements = selection.selectedElements;
          const onlyOne = elements.length === 1;

          if (onlyOne) {
            const element = elements[0];
            const id = element.id;

            if (element.isLocked()) return;

            if (element instanceof ConnectorElementModel) {
              selection.set({
                elements: [id],
                editing: true,
              });
              requestAnimationFrame(() => {
                mountConnectorLabelEditor(element, rootComponent);
              });
              return;
            }

            if (element instanceof EdgelessTextBlockModel) {
              selection.set({
                elements: [id],
                editing: true,
              });
              const textBlock = rootComponent.host.view.getBlock(id);
              if (textBlock instanceof EdgelessTextBlockComponent) {
                textBlock.tryFocusEnd();
              }

              return;
            }
          }
        },
      },
      {
        global: true,
      },
    );

    this._bindToggleHand();
  }

  private _bindToggleHand() {
    this.rootComponent.handleEvent(
      "keyDown",
      (ctx) => {
        const event = ctx.get("keyboardState").raw;
        if (event.code === "Space" && !event.repeat) {
          this._space(event);
        }

        return false;
      },
      { global: true },
    );
    this.rootComponent.handleEvent(
      "keyUp",
      (ctx) => {
        const event = ctx.get("keyboardState").raw;
        if (event.code === "Space" && !event.repeat) {
          this._space(event);
        }
        return false;
      },
      { global: true },
    );
  }

  private _delete() {
    const edgeless = this.rootComponent;

    if (edgeless.service.locked) return;
    if (edgeless.service.selection.editing) {
      return;
    }

    const selectedElements = edgeless.service.selection.selectedElements;
    if (
      edgeless.store.readonly ||
      selectedElements.some((element) =>
        edgeless.store.hasFixedText(element.id),
      )
    )
      return;
    if (selectedElements.some((e) => e.isLocked())) return;

    deleteElements(edgeless, selectedElements);
    edgeless.service.selection.clear();
  }

  private _move(key: string, shift = false) {
    const edgeless = this.rootComponent;

    if (edgeless.service.locked) return;
    if (edgeless.service.selection.editing) return;

    const { selectedElements } = edgeless.service.selection;
    const inc = shift ? 10 : 1;

    if (selectedElements.some((e) => e.isLocked())) return;

    const movedElements = new Set([
      ...selectedElements,
      ...selectedElements.flatMap((el) =>
        isGfxGroupCompatibleModel(el) ? el.descendantElements : [],
      ),
    ]);

    this.std
      .get(InteractivityIdentifier)
      .resolveMoveElements([...movedElements])
      .forEach((element) => {
        const bound = Bound.deserialize(element.xywh).clone();

        switch (key) {
          case "ArrowUp":
            bound.y -= inc;
            break;
          case "ArrowLeft":
            bound.x -= inc;
            break;
          case "ArrowRight":
            bound.x += inc;
            break;
          case "ArrowDown":
            bound.y += inc;
            break;
        }

        if (isCanvasElement(element)) {
          if (element instanceof ConnectorElementModel) {
            element.moveTo(bound);
          }
          element["xywh"] = bound.serialize();
        } else {
          element["xywh"] = bound.serialize();
        }
      });
  }

  private _setEdgelessTool<T extends BaseTool>(
    toolType: ToolType<T>,
    ...options: [options?: ToolOptions<T>, ignoreActiveState?: boolean]
  ) {
    const ignoreActiveState =
      typeof options === "boolean"
        ? options[0]
        : options[1] === undefined
          ? false
          : options[1];

    // when editing, should not update mouse mode by shortcut
    if (!ignoreActiveState && this.rootComponent.gfx.selection.editing) {
      return;
    }

    this.rootComponent.gfx.tool.setTool(
      toolType,
      options[0] !== undefined && typeof options[0] !== "boolean"
        ? options[0]
        : undefined,
    );
  }

  private _space(event: KeyboardEvent) {
    /*
    Call this function with a check for !event.repeat to consider only the first keydown (not repeat). This way, you can use onPressSpaceBar in a tool to determine if the space bar is pressed or not.
  */

    const edgeless = this.rootComponent;
    const selection = edgeless.service.selection;
    const currentTool = edgeless.gfx.tool.currentTool$.peek()!;
    const currentSel = selection.surfaceSelections;
    const isKeyDown = event.type === "keydown";

    if (edgeless.gfx.tool.dragging$.peek()) {
      return; // Don't do anything if currently dragging
    }

    const revertToPrevTool = (ev: KeyboardEvent) => {
      if (ev.code === "Space") {
        const toolConstructor = currentTool.constructor as typeof DefaultTool;
        let finalOptions = currentTool?.activatedOption;

        // Handle frameNavigator (PresentTool) restoration after space pan
        if (currentTool.toolName === "frameNavigator") {
          finalOptions = {
            ...currentTool?.activatedOption,
            restoredAfterPan: true,
          } as PresentToolOption;
        }

        this._setEdgelessTool(toolConstructor, finalOptions);
        selection.set(currentSel);
        document.removeEventListener("keyup", revertToPrevTool, false);
      }
    };

    if (isKeyDown) {
      if (
        currentTool.toolName === "pan" ||
        (currentTool.toolName === "default" && selection.editing)
      ) {
        return;
      }

      // If in presentation mode, disable black background during space drag
      if (currentTool.toolName === "frameNavigator") {
        this.slots.navigatorSettingUpdated.next({
          blackBackground: false,
        });
      }

      this._setEdgelessTool(PanTool, { panning: false });

      this.std.event.disposables.addFromEvent(
        document,
        "keyup",
        revertToPrevTool,
      );
    }
  }
}
