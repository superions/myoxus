import { signal } from "@preact/signals-core";
import {
  NativeViewElement,
  installEditorStyles,
} from "@virgultum/core/runtime";
import { TOGGLE_BUTTON_PARENT_CLASS } from "@virgultum/core/consts";
import type {
  EditorChromeHost,
  EditorDisclosureControl,
} from "@virgultum/core/services";
export { TOGGLE_BUTTON_PARENT_CLASS } from "@virgultum/core/consts";

const disclosureStyle = `
    .toggle-icon {
      display: flex;
      align-items: center;
      justify-content: center;
      position: absolute;
      top: calc((1em - 16px) / 2 + 2px);
      left: 0;
      transform: translateX(-100%);
      opacity: 0;
      transition: opacity 0.2s ease-in-out;
    }

    .toggle-icon[data-collapsed="true"],
    .toggle-icon:focus-within,
    .${TOGGLE_BUTTON_PARENT_CLASS}:hover .toggle-icon,
    .with-drag-handle .toggle-icon {
      opacity: 1;
    }

    .with-drag-handle .myoxus-block-children-container .toggle-icon:not([data-collapsed="true"]):not(:focus-within) {
      opacity: 0;
    }
  `;

export class ToggleButton extends NativeViewElement {
  private folded = false;
  private unmount?: () => void;
  private container?: HTMLDivElement;
  private fallbackButton?: HTMLButtonElement;
  private readonly state$ = signal<EditorDisclosureControl | null>(null);

  chromeHost?: EditorChromeHost | null;

  get collapsed() {
    return this.folded;
  }
  set collapsed(value: boolean) {
    this.folded = value;
    if (this.container) {
      this.container.dataset.collapsed = String(value);
    }
    if (this.fallbackButton) {
      this.fallbackButton.setAttribute("aria-expanded", String(!value));
      this.fallbackButton.dataset.collapsed = String(value);
    }
    this.syncState();
  }

  updateCollapsed!: (collapsed: boolean) => void;

  private syncState() {
    this.state$.value = {
      collapsed: this.folded,
      toggle: () => this.updateCollapsed?.(!this.folded),
    };
  }

  connectedCallback() {
    installEditorStyles(this, disclosureStyle);
    if (this.container) return;

    const host = this.ownerDocument.createElement("div");
    host.contentEditable = "false";
    host.className = "toggle-icon";
    host.dataset.collapsed = String(this.folded);
    this.container = host;
    this.append(host);
    this.syncState();

    if (this.chromeHost?.mountDisclosureControl) {
      this.unmount = this.chromeHost.mountDisclosureControl(host, this.state$);
      return;
    }

    const fallback = this.ownerDocument.createElement("button");
    fallback.type = "button";
    fallback.setAttribute("aria-expanded", String(!this.folded));
    fallback.setAttribute("aria-label", this.folded ? "Expand" : "Collapse");
    fallback.dataset.collapsed = String(this.folded);
    fallback.textContent = this.folded ? "▸" : "▾";
    fallback.addEventListener("click", (event) => {
      event.stopPropagation();
      this.updateCollapsed?.(!this.folded);
    });
    this.fallbackButton = fallback;
    host.append(fallback);
  }

  disconnectedCallback() {
    this.unmount?.();
    this.unmount = undefined;
    this.fallbackButton = undefined;
    this.container?.remove();
    this.container = undefined;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "virgultum-toggle-button": ToggleButton;
  }
}
