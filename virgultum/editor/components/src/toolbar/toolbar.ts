import { WithDisposable } from "@virgultum/global/lit";
import { panelBaseStyle } from "@virgultum/shared/styles";
import { stopPropagation } from "@virgultum/shared/utils";
import { css, html, LitElement } from "lit";

export class EditorToolbar extends WithDisposable(LitElement) {
  static override styles = css`
    ${panelBaseStyle(":host")}
    :host {
      height: 36px;
      box-sizing: content-box;
    }

    :host([data-without-bg]) {
      border-color: transparent;
      background: transparent;
      box-shadow: none;
    }

    ::slotted(*) {
      display: flex;
      height: 100%;
      justify-content: center;
      align-items: center;
      gap: 8px;
      color: var(--myoxus-text-primary-color);
      fill: currentColor;
    }
  `;

  override connectedCallback() {
    super.connectedCallback();

    this._disposables.addFromEvent(this, "pointerdown", (e: PointerEvent) => {
      const targetsEditableControl = e.composedPath().some((target) => {
        if (!(target instanceof Element)) return false;
        return target.matches(
          ["input", "select", "textarea", "[contenteditable='true']"].join(","),
        );
      });
      e.stopPropagation();
      // Toolbar buttons act on the current editor selection. Letting them take
      // focus collapses that selection before Firefox dispatches `click` and
      // can even remove a detached floating menu action from the DOM. Inputs
      // remain focusable because typing controls genuinely require focus.
      if (!targetsEditableControl) {
        e.preventDefault();
      }
    });
    this._disposables.addFromEvent(this, "pointerup", (e: PointerEvent) => {
      e.stopPropagation();
    });
    this._disposables.addFromEvent(this, "click", (e: MouseEvent) => {
      e.stopPropagation();
    });
    this._disposables.addFromEvent(this, "wheel", stopPropagation, {
      passive: false,
    });
  }

  override render() {
    return html`<slot></slot>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "editor-toolbar": EditorToolbar;
  }
}
