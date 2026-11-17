import { EdgelessLegacySlotIdentifier } from "@virgultum/canvas-runtime/surface";
import { WithDisposable, SignalWatcher } from "@virgultum/core/primitives/lit";
import {
  EditPropsStore,
  EditorChromeHostIdentifier,
  editorMessage,
  EditorI18nProvider,
  resolveEditorMessage,
  type EditorI18nMessage,
} from "@virgultum/core/services";
import { createButtonPopper } from "@virgultum/core/utils";
import {
  type BlockComponent,
  ShadowlessElement,
} from "@virgultum/core/runtime";
import { css, html, nothing } from "lit";
import { property, query, state } from "lit/decorators.js";

export class EdgelessNavigatorSettingButton extends SignalWatcher(
  WithDisposable(ShadowlessElement),
) {
  private _text(message: EditorI18nMessage) {
    return resolveEditorMessage(
      message,
      this.edgeless.std.getOptional(EditorI18nProvider) ?? undefined,
    );
  }

  // The owning popper controls visibility; native chrome owns appearance and density.
  static override styles = css`
    edgeless-navigator-setting-button .navigator-setting-menu {
      display: none;
    }
    edgeless-navigator-setting-button .navigator-setting-menu[data-show] {
      display: block;
    }
  `;

  private _navigatorSettingPopper?: ReturnType<
    typeof createButtonPopper
  > | null = null;

  private readonly _onBlackBackgroundChange = (checked: boolean) => {
    this.blackBackground = checked;
    const slots = this.edgeless.std.get(EdgelessLegacySlotIdentifier);
    slots.navigatorSettingUpdated.next({
      blackBackground: this.blackBackground,
    });
    this.edgeless.std
      .get(EditPropsStore)
      .setStorage("presentBlackBackground", checked);
  };

  private _tryRestoreSettings() {
    const blackBackground = this.edgeless.std
      .get(EditPropsStore)
      .getStorage("presentBlackBackground");
    this.blackBackground = blackBackground ?? false;
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this._navigatorSettingPopper?.dispose();
    this._navigatorSettingPopper = null;
  }

  override firstUpdated() {
    if (this.edgeless) this._tryRestoreSettings();
    this._navigatorSettingPopper = createButtonPopper({
      reference: this._navigatorSettingButton,
      popperElement: this._navigatorSettingMenu,
      stateUpdated: ({ display }) => this.setPopperShow(display === "show"),
      mainAxis: 22,
    });
    // A remounted popper starts closed; do not retain the previous session's expanded flag.
    this.setPopperShow(false);
  }

  override render() {
    return html`
      <span class="navigator-setting-button">
        ${
          this.edgeless.std
            .getOptional(EditorChromeHostIdentifier)
            ?.renderCanvasTool({
              action: {
                id: "presentation-settings",
                label: this._text(
                  editorMessage(
                    "com.myoxus.sidebar.outline.settings",
                    "Settings",
                  ),
                ),
                icon: "SettingsIcon",
                disabled: false,
                run: () => this._navigatorSettingPopper?.toggle(),
              },
              expanded: this.popperShow,
            }) ?? nothing
        }
      </span>

      <div
        class="navigator-setting-menu"
        @click=${(e: MouseEvent) => {
          e.stopPropagation();
        }}
      >
        ${
          this.edgeless.std
            .getOptional(EditorChromeHostIdentifier)
            ?.renderCanvasMenu({
              actions: [
                {
                  id: "presentation-settings-label",
                  label: this._text(
                    editorMessage(
                      "com.myoxus.sidebar.frame.playback-settings",
                      "Playback Settings",
                    ),
                  ),
                  disabled: false,
                },
                {
                  id: "presentation-dark-background",
                  label: this._text(
                    editorMessage(
                      "com.myoxus.sidebar.frame.dark-background",
                      "Black background",
                    ),
                  ),
                  disabled: false,
                  control: {
                    type: "toggle",
                    checked: this.blackBackground,
                    change: this._onBlackBackgroundChange,
                  },
                },
                {
                  id: "presentation-hide-toolbar",
                  label: this._text(
                    editorMessage(
                      "com.myoxus.sidebar.frame.hide-toolbar",
                      "Hide toolbar",
                    ),
                  ),
                  disabled: false,
                  control: {
                    type: "toggle",
                    checked: this.hideToolbar,
                    change: (checked: boolean) =>
                      this.onHideToolbarChange?.(checked),
                  },
                },
                ...(this.includeFrameOrder
                  ? [
                      {
                        id: "presentation-frame-order-label",
                        label: this._text(
                          editorMessage(
                            "com.myoxus.editor.presentation.frame-order",
                            "Frame Order",
                          ),
                        ),
                        disabled: false,
                      },
                    ]
                  : []),
              ],
            }) ?? nothing
        }
        ${
          this.includeFrameOrder
            ? html` <edgeless-frame-order-menu
                .edgeless=${this.edgeless}
                .embed=${true}
              ></edgeless-frame-order-menu>`
            : nothing
        }
      </div>
    `;
  }

  @query(".navigator-setting-button")
  private accessor _navigatorSettingButton!: HTMLElement;

  @query(".navigator-setting-menu")
  private accessor _navigatorSettingMenu!: HTMLElement;

  @state()
  accessor blackBackground = false;

  @property({ attribute: false })
  accessor edgeless!: BlockComponent;

  @property({ attribute: false })
  accessor hideToolbar = false;

  @property({ attribute: false })
  accessor includeFrameOrder = false;

  @property({ attribute: false })
  accessor onHideToolbarChange: undefined | ((hideToolbar: boolean) => void) =
    undefined;

  @property({ attribute: false })
  accessor popperShow = false;

  @property({ attribute: false })
  accessor setPopperShow: (show: boolean) => void = () => {};
}
