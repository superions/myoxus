import type { Placement } from "@floating-ui/dom";
import { unsafeCSSVar } from "@virgultum/shared/theme";
import { css, html, LitElement, nothing, type TemplateResult } from "lit";
import { property } from "lit/decorators.js";
import { cache } from "lit/directives/cache.js";
import { styleMap } from "lit/directives/style-map.js";

export class EditorIconButton extends LitElement {
  static override styles = css`
    :host([disabled]),
    :host(:disabled) {
      pointer-events: none;
      cursor: not-allowed;
      color: var(--myoxus-text-disable-color);
    }

    .icon-container {
      position: relative;
      display: flex;
      align-items: center;
      padding: var(--icon-container-padding);
      color: ${unsafeCSSVar("iconColor")};
      border-radius: 4px;
      cursor: pointer;
      white-space: nowrap;
      box-sizing: border-box;
      width: var(--icon-container-width, unset);
      height: var(--icon-container-height, unset);
      justify-content: var(--justify, unset);
      user-select: none;
    }

    :host([active]) .icon-container.active-mode-color {
      color: var(--myoxus-primary-color);
    }

    :host([active]) .icon-container.active-mode-border {
      border: 1px solid var(--myoxus-brand-color);
    }

    :host([active]) .icon-container.active-mode-background {
      background: var(--myoxus-hover-color);
    }

    .icon-container[coming] {
      cursor: not-allowed;
      color: var(--myoxus-text-disable-color);
    }

    ::slotted(svg) {
      flex-shrink: 0;
      font-size: var(--icon-size, 20px);
    }

    ::slotted(.label) {
      flex: 1;
      padding: 0 4px;
      overflow: hidden;
      white-space: nowrap;
      line-height: var(--label-height, var(--icon-size, 20px));
    }
    ::slotted(.label.padding0) {
      padding: 0;
    }
    ::slotted(.label.ellipsis) {
      text-overflow: ellipsis;
    }
    ::slotted(.label.medium) {
      font-weight: 500;
    }

    .icon-container[with-hover]::before {
      content: "";
      display: block;
      background: var(--myoxus-hover-color);
      position: absolute;
      width: 100%;
      height: 100%;
      top: 0;
      left: 0;
      border-radius: 4px;
    }
  `;

  constructor() {
    super();

    // Allow activate button by pressing Enter key
    this.addEventListener("keypress", (event) => {
      if (this.disabled) {
        return;
      }
      if (event.key === "Enter" && !event.isComposing) {
        this.click();
      }
    });

    // Prevent click event when disabled
    this.addEventListener(
      "click",
      (event) => {
        if (this._suppressNextTrustedClick && event.isTrusted) {
          event.stopPropagation();
          event.preventDefault();
          return;
        }
        if (this.disabled) {
          event.stopPropagation();
          event.preventDefault();
        }
      },
      { capture: true },
    );

    this.addEventListener("pointerup", this._activateToolbarButtonFromPointer);
  }

  override connectedCallback() {
    super.connectedCallback();
    this.tabIndex = 0;
    this.role = "button";
  }

  override render() {
    const tooltip = this.coming ? "(Coming soon)" : this.tooltip;
    const classnames = `icon-container active-mode-${this.activeMode} ${this.hoverState ? "hovered" : ""}`;
    const padding = this.iconContainerPadding;
    const iconContainerStyles = styleMap({
      "--icon-container-width": this.iconContainerWidth,
      "--icon-container-height": this.iconContainerHeight,
      "--icon-container-padding": Array.isArray(padding)
        ? padding.map((v) => `${v}px`).join(" ")
        : `${padding}px`,
      "--icon-size": this.iconSize,
      "--justify": this.justify,
      "--label-height": this.labelHeight,
    });

    return html`
      <style>
        .icon-container:hover,
        .icon-container.hovered {
          background: ${this.hover ? `var(--myoxus-hover-color)` : "inherit"};
        }
      </style>
      <div
        class=${classnames}
        style=${iconContainerStyles}
        ?with-hover=${this.withHover}
        ?disabled=${this.disabled}
        @pointerup=${this._activateToolbarButtonFromPointer}
      >
        <slot></slot>
        ${cache(
          this.showTooltip && tooltip
            ? html`<myoxus-tooltip
                tip-position=${this.tipPosition}
                .arrow=${this.arrow}
                .offset=${this.tooltipOffset}
                >${tooltip}</myoxus-tooltip
              >`
            : nothing,
        )}
      </div>
    `;
  }

  @property({ type: Boolean, reflect: true })
  accessor active = false;

  @property({ attribute: false })
  accessor activeMode: "color" | "border" | "background" = "color";

  @property({ attribute: false })
  accessor arrow = true;

  @property({ attribute: false })
  accessor coming = false;

  @property({ type: Boolean, reflect: true })
  accessor disabled = false;

  @property({ attribute: false })
  accessor hover = true;

  @property({ attribute: false })
  accessor hoverState = false;

  @property({ attribute: false })
  accessor iconContainerPadding: number | number[] = 2;

  @property({ attribute: false })
  accessor iconContainerWidth: string | undefined = undefined;

  @property({ attribute: false })
  accessor iconContainerHeight: string | undefined = undefined;

  @property({ attribute: false })
  accessor iconSize: string | undefined = undefined;

  @property({ attribute: false })
  accessor justify: string | undefined = undefined;

  @property({ attribute: false })
  accessor labelHeight: string | undefined = undefined;

  @property({ type: Boolean })
  accessor showTooltip = true;

  @property({ attribute: false })
  accessor tipPosition: Placement = "top";

  @property({ attribute: false })
  accessor tooltip!: string | TemplateResult<1>;

  @property({ attribute: false })
  accessor tooltipOffset = 8;

  @property({ attribute: false })
  accessor withHover: boolean | undefined = undefined;

  private _suppressNextTrustedClick = false;

  private _activateToolbarButtonFromPointer = (event: PointerEvent) => {
    if (
      this.disabled ||
      event.button !== 0 ||
      !this.closest("editor-toolbar")
    ) {
      return;
    }

    event.stopPropagation();
    this._suppressNextTrustedClick = true;
    this.click();
    setTimeout(() => {
      this._suppressNextTrustedClick = false;
    }, 0);
  };
}

declare global {
  interface HTMLElementTagNameMap {
    "editor-icon-button": EditorIconButton;
  }
}
