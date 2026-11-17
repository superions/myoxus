import { SignalWatcher, WithDisposable } from "@virgultum/core/primitives/lit";
import {
  VirtualKeyboardProvider,
  EditorChromeHostIdentifier,
} from "@virgultum/core/services";
import { getViewportElement } from "@virgultum/core/utils";
import {
  PropTypes,
  requiredProperties,
  ShadowlessElement,
} from "@virgultum/core/runtime";
import { nothing } from "lit";
import { property } from "lit/decorators.js";
import type { LinkedDocContext } from "./config.js";
import { DocumentPickerSession } from "./document-picker-session";

export const MYOXUS_MOBILE_LINKED_DOC_MENU = "myoxus-mobile-linked-doc-menu";

@requiredProperties({ context: PropTypes.object })
export class MyoxusMobileLinkedDocMenu extends SignalWatcher(
  WithDisposable(ShadowlessElement),
) {
  private session?: DocumentPickerSession;

  private readonly _scrollInputToTop = () => {
    const { inlineEditor } = this.context;
    const { scrollContainer, scrollTopOffset } = this.context.config.mobile;

    let container = null;
    let containerScrollTop = 0;
    if (typeof scrollContainer === "string") {
      container = document.querySelector(scrollContainer);
      containerScrollTop = container?.scrollTop ?? 0;
    } else if (scrollContainer instanceof HTMLElement) {
      container = scrollContainer;
      containerScrollTop = scrollContainer.scrollTop;
    } else if (scrollContainer === window) {
      container = window;
      containerScrollTop = scrollContainer.scrollY;
    } else {
      container = getViewportElement(this.context.std.host);
      containerScrollTop = container?.scrollTop ?? 0;
    }

    let offset = 0;
    if (typeof scrollTopOffset === "function") {
      offset = scrollTopOffset();
    } else {
      offset = scrollTopOffset ?? 0;
    }

    if (!inlineEditor.rootElement || !container) return;
    container.scrollTo({
      top:
        inlineEditor.rootElement.getBoundingClientRect().top +
        containerScrollTop -
        offset,
      behavior: "smooth",
    });
  };

  get keyboard() {
    return this.context.std.get(VirtualKeyboardProvider);
  }

  override connectedCallback() {
    super.connectedCallback();
    const session = (this.session = new DocumentPickerSession(
      this.context,
      "docked",
    ));
    this.disposables.add(session.cancel);
    // The virtual keyboard owns this fixed viewport; native Card/ScrollArea own its chrome.
    Object.assign(this.style, {
      position: "fixed",
      width: "100%",
      height: "220px",
    });
    this.disposables.addFromEvent(this, "pointerdown", (event) =>
      event.preventDefault(),
    );
    this.disposables.addFromEvent(
      window,
      "pointerdown",
      (event) => {
        if (!event.composedPath().includes(this)) session.cancel();
      },
      true,
    );
  }

  override firstUpdated() {
    this._scrollInputToTop();
  }

  override render() {
    if (!this.session) return nothing;
    this.style.bottom = `${this.keyboard.height$.value}px`;
    return (
      this.context.std
        .getOptional(EditorChromeHostIdentifier)
        ?.renderDocumentPicker(this.session) ?? nothing
    );
  }

  @property({ attribute: false }) accessor context!: LinkedDocContext;
}
