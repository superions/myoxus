import { limitShift, offset, shift, size } from "@floating-ui/dom";
import { HoverController } from "@virgultum/core/view/hover";
import { signal } from "@preact/signals-core";
import {
  DocModeProvider,
  EditorChromeHostIdentifier,
} from "@virgultum/core/services";
import type { CodeBlockModel } from "@virgultum/core/models";
import {
  BlockSelection,
  TextSelection,
  NativeEditorWidget,
} from "@virgultum/core/runtime";
import { mountEditorPortal } from "@virgultum/core/view/portal";

import { CodeBlockComponent } from "../code-block";
import { CodeBlockToolbarContext } from "./context";
import {
  createCodeToolbarControls,
  type CodeToolbarActions,
} from "./controller";

export const MYOXUS_CODE_TOOLBAR_WIDGET = "myoxus-code-toolbar-widget";
export class MyoxusCodeToolbarWidget extends NativeEditorWidget<CodeBlockModel> {
  private get codeBlock() {
    const block = this.block;
    return block instanceof CodeBlockComponent ? block : null;
  }
  override connectedCallback() {
    super.connectedCallback();
    const codeBlock = this.codeBlock;
    if (!codeBlock) return;
    let activeMenu = false;
    const hover = new HoverController(
      this,
      ({ abortController }) => {
        const chrome = this.std.getOptional(EditorChromeHostIdentifier);
        if (!chrome) {
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
          activeMenu = active;
          if (!active && !hover.isHovering) {
            hover.abort();
          }
        };

        const context = new CodeBlockToolbarContext(
          codeBlock,
          abortController,
          setActive,
        );

        const headerElement =
          codeBlock.querySelector<HTMLElement>(".myoxus-code-block-header") ??
          codeBlock;

        return mountEditorPortal(
          this.host,
          abortController,
          (anchor) =>
            chrome.mountCodeToolbar(
              anchor,
              createCodeToolbarControls(
                context,
                () => this.primaryActions.value,
              ),
            ),
          {
            referenceElement: edgeless ? codeBlock : headerElement,
            placement: "top",
            middleware: [
              // Canvas content scales; native chrome stays above it at normal UI density.
              offset(({ rects }) => (edgeless ? 8 : -rects.floating.height)),
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
        );
      },
      { allowMultiple: true },
    );

    hover.hostConnected();
    this.disposables.add(() => hover.hostDisconnected());
    hover.setReference(codeBlock);
    hover.onAbort = () => {
      // If the more menu is opened, don't close it.
      if (activeMenu) return;
      hover.abort();
      return;
    };
  }

  private readonly primaryActions = signal<CodeToolbarActions[]>([]);

  addPrimaryActions(factory: CodeToolbarActions) {
    this.primaryActions.value = [...this.primaryActions.value, factory];
  }
  /** Resume an optional Page command only after the receiving widget and its
   * configured extensions own the selected block. */
  runPageCommand(id: string) {
    const block = this.codeBlock;
    if (!this.isConnected || !block) return;
    const abort = new AbortController();
    this.disposables.add(() => abort.abort());
    const context = new CodeBlockToolbarContext(block, abort, () => {});
    const controls = createCodeToolbarControls(
      context,
      () => this.primaryActions.value,
    );
    const { primary, more } = controls.getSnapshot();
    const menu = primary.find((action) => action.id === "ask-ai")?.control;
    const menuActions =
      menu?.type === "menu"
        ? menu.items.flatMap((group) => group.actions ?? [group])
        : [];
    const flatMore = more.flatMap((item) => item.actions ?? [item]);
    const action = [...primary, ...flatMore, ...menuActions].find(
      (a) => a.id === id,
    );
    if (action && !action.disabled && action.run)
      action.run(block, new MouseEvent("click"));
  }
}
