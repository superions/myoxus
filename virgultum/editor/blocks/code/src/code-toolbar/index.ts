import { limitShift, offset, shift, size } from "@floating-ui/dom";
import { HoverController } from "@virgultum/components/hover";
import { signal } from "@preact/signals-core";
import {
  DocModeProvider,
  EditorChromeHostIdentifier,
} from "@virgultum/shared/services";
import type { CodeBlockModel } from "@virgultum/model";
import { BlockSelection, TextSelection, WidgetComponent } from "@virgultum/std";
import { html } from "lit";

import type { CodeBlockComponent } from "../code-block.js";
import { CodeBlockToolbarContext } from "./context.js";
import {
  createCodeToolbarControls,
  type CodeToolbarActions,
} from "./controller";

export const MYOXUS_CODE_TOOLBAR_WIDGET = "myoxus-code-toolbar-widget";
export class MyoxusCodeToolbarWidget extends WidgetComponent<
  CodeBlockModel,
  CodeBlockComponent
> {
  private _hoverController: HoverController | null = null;

  private _isActivated = false;

  private readonly _setHoverController = () => {
    this._hoverController = null;
    this._hoverController = new HoverController(
      this,
      ({ abortController }) => {
        const codeBlock = this.block;
        const chrome = this.std.getOptional(EditorChromeHostIdentifier);
        if (!codeBlock || !chrome) {
          return null;
        }

        const selection = this.host.selection;
        const edgeless =
          this.std.get(DocModeProvider).getEditorMode() === "edgeless";

        const textSelection = selection.find(TextSelection);
        if (
          !!textSelection &&
          (!!textSelection.to || !!textSelection.from.length)
        ) {
          return null;
        }

        const blockSelections = selection.filter(BlockSelection);
        if (
          blockSelections.length > 1 ||
          (blockSelections.length === 1 &&
            blockSelections[0].blockId !== codeBlock.blockId)
        ) {
          return null;
        }

        const setActive = (active: boolean) => {
          this._isActivated = active;
          if (!active && !this._hoverController?.isHovering) {
            this._hoverController?.abort();
          }
        };

        const context = new CodeBlockToolbarContext(
          codeBlock,
          abortController,
          setActive,
        );

        return {
          shadowDom: false,
          template: html`${chrome.renderCodeToolbar(
            createCodeToolbarControls(context, () => this.primaryActions.value),
          )}`,
          // Native controls must not participate in the document's caret tree.
          container: this.host,
          // stacking-context(editor-host)
          portalStyles: {
            zIndex: "var(--myoxus-z-index-popover)",
          },
          computePosition: {
            referenceElement: codeBlock,
            placement: "top",
            middleware: [
              // Canvas content scales; native chrome stays above it at normal UI density.
              offset(({ rects }) => (edgeless ? 0 : -rects.floating.height)),
              size({
                apply({ rects, elements }) {
                  elements.floating.style.width = edgeless
                    ? "max-content"
                    : `${rects.reference.width}px`;
                },
              }),
              shift({
                crossAxis: true,
                padding: {
                  bottom: 12,
                  right: 12,
                },
                limiter: limitShift(),
              }),
            ],
            autoUpdate: { animationFrame: true },
          },
        };
      },
      { allowMultiple: true },
    );

    const codeBlock = this.block;
    if (!codeBlock) {
      return;
    }
    this._hoverController.setReference(codeBlock);
    this._hoverController.onAbort = () => {
      // If the more menu is opened, don't close it.
      if (this._isActivated) return;
      this._hoverController?.abort();
      return;
    };
  };

  private readonly primaryActions = signal<CodeToolbarActions[]>([]);

  addPrimaryActions(factory: CodeToolbarActions) {
    this.primaryActions.value = [...this.primaryActions.value, factory];
  }

  override firstUpdated() {
    this._setHoverController();
  }
}
