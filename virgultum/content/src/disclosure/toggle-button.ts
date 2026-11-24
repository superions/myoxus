import {
  NativeViewElement,
  installEditorStyles,
} from "@virgultum/core/runtime";
import { TOGGLE_BUTTON_PARENT_CLASS } from "@virgultum/core/consts";
export { TOGGLE_BUTTON_PARENT_CLASS } from "@virgultum/core/consts";
const disclosureStyle = `
    .toggle-icon {
      display: flex;
      align-items: start;
      justify-content: start;
      position: absolute;
      width: 16px;
      height: 16px;
      top: calc((1em - 16px) / 2 + 5px);
      left: 0;
      transform: translateX(-100%);
      border-radius: 4px;
      cursor: pointer;
      opacity: 0;
      transition: opacity 0.2s ease-in-out;
    }

    .toggle-icon:hover {
      background: var(--myoxus-hover-color);
    }

    .toggle-icon[data-collapsed="true"] {
      opacity: 1;
    }

    .${TOGGLE_BUTTON_PARENT_CLASS}:hover .toggle-icon {
      opacity: 1;
    }

    .with-drag-handle .toggle-icon {
      opacity: 1;
    }
    .with-drag-handle .myoxus-block-children-container .toggle-icon {
      opacity: 0;
    }

    .myoxus-disclosure-triangle {
      width: var(--mantine-spacing-md);
      height: var(--mantine-spacing-md);
      color: var(--myoxus-icon-color);
      transition: transform 0.2s ease-in-out;
    }

    .toggle-icon[data-collapsed="false"] .myoxus-disclosure-triangle {
      transform: rotate(90deg);
    }
  `;
export class ToggleButton extends NativeViewElement {
  private folded = false;
  get collapsed() {
    return this.folded;
  }
  set collapsed(value: boolean) {
    this.folded = value;
    this.firstElementChild?.setAttribute("data-collapsed", String(value));
  }
  updateCollapsed!: (collapsed: boolean) => void;
  connectedCallback() {
    installEditorStyles(this, disclosureStyle);
    if (this.firstChild) return;
    const button = this.ownerDocument.createElement("div");
    button.contentEditable = "false";
    button.className = "toggle-icon";
    button.dataset.collapsed = String(this.folded);
    button.innerHTML =
      '<svg class="myoxus-disclosure-triangle" aria-hidden="true" focusable="false" viewBox="0 0 16 16"><path d="M5.5 3.5L10.5 8L5.5 12.5Z" fill="currentColor"></path></svg>';
    button.addEventListener("click", () => this.updateCollapsed(!this.folded));
    this.append(button);
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "virgultum-toggle-button": ToggleButton;
  }
}
