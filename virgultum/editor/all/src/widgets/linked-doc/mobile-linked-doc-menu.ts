import { DisposableGroup } from "@virgultum/core/primitives/disposable";
import {
  VirtualKeyboardProvider,
  EditorChromeHostIdentifier,
} from "@virgultum/core/services";
import { getViewportElement } from "@virgultum/core/utils";
import { NativeViewElement } from "@virgultum/core/runtime";
import type { LinkedDocContext } from "./config.js";
import { DocumentPickerSession } from "./document-picker-session";

export const MYOXUS_MOBILE_LINKED_DOC_MENU = "myoxus-mobile-linked-doc-menu";

export class MyoxusMobileLinkedDocMenu extends NativeViewElement {
  context!: LinkedDocContext;
  private disposables = new DisposableGroup();

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

  connectedCallback() {
    this.disposables = new DisposableGroup();
    const session = new DocumentPickerSession(this.context, "docked");
    if (!this.isConnected) return;
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
    this.disposables.add(
      this.keyboard.height$.subscribe((height) => {
        this.style.bottom = `${height}px`;
      }),
    );
    this.disposables.add(
      this.context.std
        .get(EditorChromeHostIdentifier)
        .mountDocumentPicker(this, session),
    );
    this._scrollInputToTop();
  }

  disconnectedCallback() {
    this.disposables.dispose();
  }
}
