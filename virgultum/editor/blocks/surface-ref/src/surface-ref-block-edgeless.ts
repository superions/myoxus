import { EditorI18nProvider } from "@virgultum/shared/services";
import { type SurfaceRefBlockModel } from "@virgultum/model";
import { unsafeCSSVar } from "@virgultum/shared/theme";
import { BlockComponent, BlockSelection } from "@virgultum/std";
import { GfxControllerIdentifier, type GfxModel } from "@virgultum/std/gfx";
import { css, html } from "lit";
import { state } from "lit/decorators.js";
import { classMap } from "lit/directives/class-map.js";

export class EdgelessSurfaceRefBlockComponent extends BlockComponent<SurfaceRefBlockModel> {
  static override styles = css`
    myoxus-edgeless-surface-ref {
      position: relative;
      overflow: hidden;
    }

    .myoxus-edgeless-surface-ref-container {
      border-radius: 8px;
      border: 1px solid ${unsafeCSSVar("borderColor")};
      margin: 18px 0;
    }

    .myoxus-edgeless-surface-ref-container.focused {
      border-color: ${unsafeCSSVar("primaryColor")};
    }
  `;

  override connectedCallback(): void {
    super.connectedCallback();

    const elementModel = this.gfx.getElementById(
      this.model.props.reference,
    ) as GfxModel;

    this._referenceModel = elementModel;
    this._initSelection();
  }

  private _initSelection() {
    const selection = this.std.selection;
    this._disposables.add(
      selection.slots.changed.subscribe((selList) => {
        this._focused = selList.some(
          (sel) => sel.blockId === this.blockId && sel.is(BlockSelection),
        );
      }),
    );
  }

  get gfx() {
    return this.std.get(GfxControllerIdentifier);
  }

  @state()
  accessor _referenceModel: GfxModel | null = null;

  @state()
  accessor _focused = false;

  override renderBlock() {
    return html` <div
      class=${classMap({
        "myoxus-edgeless-surface-ref-container": true,
        focused: this._focused,
      })}
    >
      <surface-ref-placeholder
        .i18n=${this.std.getOptional(EditorI18nProvider) ?? undefined}
        .referenceModel=${this._referenceModel}
        .refFlavour=${this.model.props.refFlavour$.value}
        .inEdgeless=${true}
      ></surface-ref-placeholder>
    </div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "myoxus-edgeless-surface-ref": EdgelessSurfaceRefBlockComponent;
  }
}
