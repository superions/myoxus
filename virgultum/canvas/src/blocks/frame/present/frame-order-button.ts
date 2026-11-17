import { WithDisposable } from "@virgultum/core/primitives/lit";
import type { FrameBlockModel } from "@virgultum/core/models";
import { createButtonPopper } from "@virgultum/core/utils";
import {
  type BlockComponent,
  ShadowlessElement,
} from "@virgultum/core/runtime";
import {
  EditorChromeHostIdentifier,
  EditorI18nProvider,
  editorMessage,
  resolveEditorMessage,
} from "@virgultum/core/services";
import { css, html, nothing } from "lit";
import { property, query } from "lit/decorators.js";

import type { EdgelessFrameOrderMenu } from "./frame-order-menu.js";

export class EdgelessFrameOrderButton extends WithDisposable(
  ShadowlessElement,
) {
  static override styles = css`
    edgeless-frame-order-button edgeless-frame-order-menu {
      display: none;
    }

    edgeless-frame-order-button edgeless-frame-order-menu[data-show] {
      display: initial;
    }
  `;

  private _edgelessFrameOrderPopper: ReturnType<
    typeof createButtonPopper
  > | null = null;

  override disconnectedCallback() {
    super.disconnectedCallback();
    this._edgelessFrameOrderPopper?.dispose();
  }

  override firstUpdated() {
    this._edgelessFrameOrderPopper = createButtonPopper({
      reference: this._edgelessFrameOrderButton,
      popperElement: this._edgelessFrameOrderMenu,
      stateUpdated: ({ display }) => this.setPopperShow(display === "show"),
      mainAxis: 22,
    });
  }

  protected override render() {
    const { readonly } = this.edgeless.store;
    return html`
      <span class="edgeless-frame-order-button">
        ${
          this.edgeless.std
            .getOptional(EditorChromeHostIdentifier)
            ?.renderCanvasTool({
              action: {
                id: "presentation-frame-order",
                icon: "LayerIcon",
                label: resolveEditorMessage(
                  editorMessage(
                    "com.myoxus.editor.presentation.frame-order",
                    "Frame order",
                  ),
                  this.edgeless.std.getOptional(EditorI18nProvider) ??
                    undefined,
                ),
                disabled: readonly,
                run: () => {
                  if (readonly) return;
                  this._edgelessFrameOrderPopper?.toggle();
                },
              },
              expanded: this.popperShow,
            }) ?? nothing
        }
      </span>
      <edgeless-frame-order-menu .edgeless=${this.edgeless}>
      </edgeless-frame-order-menu>
    `;
  }

  @query(".edgeless-frame-order-button")
  private accessor _edgelessFrameOrderButton!: HTMLElement;

  @query("edgeless-frame-order-menu")
  private accessor _edgelessFrameOrderMenu!: EdgelessFrameOrderMenu;

  @property({ attribute: false })
  accessor edgeless!: BlockComponent;

  @property({ attribute: false })
  accessor frames!: FrameBlockModel[];

  @property({ attribute: false })
  accessor popperShow = false;

  @property({ attribute: false })
  accessor setPopperShow: (show: boolean) => void = () => {};
}
