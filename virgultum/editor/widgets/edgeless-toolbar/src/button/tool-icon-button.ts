import type { Placement } from "@floating-ui/dom";
import { cssVar } from "@myoxus/theme";
import {
  css,
  html,
  LitElement,
  nothing,
  type PropertyValues,
  type TemplateResult,
  unsafeCSS,
} from "lit";
import { property } from "lit/decorators.js";
import { cache } from "lit/directives/cache.js";
import { styleMap } from "lit/directives/style-map.js";

export class EdgelessToolIconButton extends LitElement {
  static override styles = css`
    .icon-container {
      position: relative;
      display: flex;
      align-items: center;
      padding: var(--icon-container-padding);
      color: var(--myoxus-icon-color);
      border-radius: 4px;
      cursor: pointer;
      white-space: nowrap;
      box-sizing: border-box;
      width: var(--icon-container-width, unset);
      height: var(--icon-container-height, unset);
      justify-content: var(--justify, unset);
    }

    .icon-container.active-mode-color[active] {
      color: var(--myoxus-primary-color);
    }

    .icon-container.active-mode-background[active] {
      background: ${unsafeCSS(cssVar("hoverColor"))};
    }

    .icon-container[disabled] {
      pointer-events: none;
      cursor: not-allowed;
      color: var(--myoxus-text-disable-color);
    }

    .icon-container[coming] {
      cursor: not-allowed;
      color: var(--myoxus-text-disable-color);
    }

    ::slotted(svg) {
      flex-shrink: 0;
      width: var(--icon-size, unset);
      height: var(--icon-size, unset);
    }

    ::slotted(.label) {
      flex: 1;
      padding: 0 4px;
      overflow: hidden;
      white-space: nowrap;
      line-height: var(--label-height, inherit);
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
      background: ${unsafeCSS(cssVar("hoverColor"))};
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

    this.addEventListener("keydown", (event) => {
      if (this.disabled) {
        return;
      }
      if ((event.key === "Enter" || event.key === " ") && !event.isComposing) {
        event.preventDefault();
        this.click();
      }
    });

    this.addEventListener(
      "click",
      (event) => {
        if (this.disabled) {
          event.stopPropagation();
          event.preventDefault();
        }
      },
      { capture: true },
    );
  }

  private _autoAriaLabel: string | null = null;

  private _tooltipLabel() {
    const tooltip = this.coming ? "(Coming soon)" : this.tooltip;
    return typeof tooltip === "string" ? tooltip.trim() : "";
  }

  private _syncAccessibleChrome() {
    if (!this.dataset.myoxusUiRole) {
      this.dataset.myoxusUiRole = "button:icon-only:editor";
    }

    const nextLabel = this._tooltipLabel();
    const currentLabel = this.getAttribute("aria-label");
    const currentIsAuto =
      currentLabel === this._autoAriaLabel || currentLabel === null;

    if (currentIsAuto && nextLabel) {
      this.setAttribute("aria-label", nextLabel);
      this._autoAriaLabel = nextLabel;
    } else if (currentIsAuto && !nextLabel) {
      this.removeAttribute("aria-label");
      this._autoAriaLabel = null;
    }
  }

  override connectedCallback() {
    super.connectedCallback();
    this.tabIndex = 0;
    this.role = "button";
    this._syncAccessibleChrome();
  }

  override updated(changedProperties: PropertyValues<this>) {
    if (changedProperties.has("tooltip") || changedProperties.has("coming")) {
      this._syncAccessibleChrome();
    }
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
          background: ${this.hover ? cssVar("hoverColor") : "inherit"};
        }
      </style>
      <div
        class=${classnames}
        style=${iconContainerStyles}
        ?with-hover=${this.withHover}
        ?disabled=${this.disabled}
        ?active=${this.active}
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

  @property({ attribute: false })
  accessor active = false;

  @property({ attribute: false })
  accessor activeMode: "color" | "background" = "color";

  @property({ attribute: false })
  accessor arrow = true;

  @property({ attribute: false })
  accessor coming = false;

  @property({ attribute: false })
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
}
