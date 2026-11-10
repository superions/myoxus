import { SignalWatcher, WithDisposable } from "@virgultum/global/lit";
import {
  VirtualKeyboardProvider,
  type EditorDocumentPickerState,
} from "@virgultum/shared/services";
import { getViewportElement } from "@virgultum/shared/utils";
import { PropTypes, requiredProperties } from "@virgultum/std";
import { html, LitElement, nothing } from "lit";
import { property } from "lit/decorators.js";
import { join } from "lit/directives/join.js";
import { repeat } from "lit/directives/repeat.js";
import type { LinkedDocContext, LinkedMenuItem } from "./config.js";
import {
  DateTimeIcon,
  EdgelessIcon,
  ImportIcon,
  LinkIcon,
  NewXxxPageIcon,
  NewXxxEdgelessIcon,
  TodayIcon,
  TomorrowIcon,
  YesterdayIcon,
  UserIcon,
  MoreHorizontalIcon,
  WarningIcon,
} from "@myoxus/icons/lit";

import { DocumentPickerSession } from "./document-picker-session";
import { mobileLinkedDocMenuStyles } from "./styles.js";

const mobileIcons = {
  DateTimeIcon,
  EdgelessIcon,
  ImportIcon,
  LinkIcon,
  NewXxxPageIcon,
  NewXxxEdgelessIcon,
  TodayIcon,
  TomorrowIcon,
  YesterdayIcon,
  UserIcon,
  MoreHorizontalIcon,
  WarningIcon,
};

/** The retained mobile renderer consumes the same plain presentation as native chrome. */
function mobileMenuIcon(item: Pick<LinkedMenuItem, "icon" | "avatar">) {
  if (item.avatar)
    return html`<img
      src=${item.avatar}
      alt=""
      style="width:var(--mantine-spacing-lg);height:var(--mantine-spacing-lg);border-radius:var(--mantine-radius-xl)"
    />`;
  const icon = mobileIcons[item.icon as keyof typeof mobileIcons] ?? LinkIcon;
  return icon();
}

export const MYOXUS_MOBILE_LINKED_DOC_MENU = "myoxus-mobile-linked-doc-menu";

@requiredProperties({ context: PropTypes.object })
export class MyoxusMobileLinkedDocMenu extends SignalWatcher(
  WithDisposable(LitElement),
) {
  static override styles = mobileLinkedDocMenuStyles;
  private session?: DocumentPickerSession;

  private readonly _renderGroup = (
    group: EditorDocumentPickerState["groups"][number],
  ) => html`
    ${!group.loading && !group.items.length && group.emptyMessage ? html`<div role="status">${group.emptyMessage}</div>` : nothing}
    ${repeat(
      group.items,
      (item) => item.id,
      (item) =>
        html`<button
          class="mobile-linked-doc-menu-item"
          ?disabled=${item.disabled}
          data-id=${item.id}
          @pointerup=${() => this.session?.choose(item.id)}
        >
          ${mobileMenuIcon(item)}
          <div class="text">${item.name}</div>
        </button>`,
    )}
  `;

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
    const session = (this.session = new DocumentPickerSession(this.context));
    this.disposables.add(session.cancel);
    this.disposables.addFromEvent(this, "pointerdown", (event) =>
      event.preventDefault(),
    );
    this.disposables.addFromEvent(
      window,
      "pointerdown",
      (event) => {
        if (event.target !== this) session.cancel();
      },
      true,
    );
  }

  override firstUpdated() {
    this._scrollInputToTop();
  }

  override render() {
    const groups = this.session?.getSnapshot().groups ?? [];
    if (!groups.length) return nothing;
    this.style.bottom = `${this.keyboard.height$.value}px`;
    return html`${join(groups.map(this._renderGroup), html`<div class="divider"></div>`)}`;
  }

  @property({ attribute: false }) accessor context!: LinkedDocContext;
}
