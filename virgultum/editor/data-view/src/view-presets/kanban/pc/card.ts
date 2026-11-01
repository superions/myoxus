import { CenterPeekIcon, MoreHorizontalIcon } from "@myoxus/icons/lit";
import { cssVar } from "@myoxus/theme";
import { signal } from "@preact/signals-core";
import { popupTargetFromElement } from "@virgultum/components/context-menu";
import { SignalWatcher, WithDisposable } from "@virgultum/global/lit";
import { unsafeCSSValue } from "@virgultum/shared/theme";
import { ShadowlessElement } from "@virgultum/std";
import { css, unsafeCSS } from "lit";
import { property } from "lit/decorators.js";
import { classMap } from "lit/directives/class-map.js";
import { repeat } from "lit/directives/repeat.js";
import { html } from "lit/static-html.js";

import { kanbanAccessibleText } from "../kanban-accessibility.js";
import type { KanbanColumn } from "../kanban-view-manager.js";
import type { KanbanViewUILogic } from "./kanban-view-ui-logic.js";
import { openDetail, popCardMenu } from "./menu.js";

const styles = css`
  myoxus-data-view-kanban-card {
    display: flex;
    position: relative;
    flex-shrink: 0;
    flex-direction: column;
    border: 1px solid ${unsafeCSS(cssVar("borderColor"))};
    box-shadow: ${unsafeCSSValue("var(--mantine-shadow-sm)")};
    border-radius: ${unsafeCSSValue("var(--mantine-radius-lg)")};
    transition: background-color 100ms ease-in-out;
    background-color: var(--myoxus-background-kanban-card-color);
    min-width: 0;
  }

  myoxus-data-view-kanban-card:hover {
    background-color: ${unsafeCSS(cssVar("hoverColor"))};
  }

  myoxus-data-view-kanban-card .card-header {
    padding: ${unsafeCSSValue("var(--mantine-spacing-sm)")};
    display: flex;
    flex-direction: column;
    gap: ${unsafeCSSValue("var(--mantine-spacing-sm)")};
  }

  myoxus-data-view-kanban-card .card-header-title uni-lit {
    width: 100%;
  }

  .card-header.has-divider {
    border-bottom: 0.5px solid ${unsafeCSS(cssVar("borderColor"))};
  }

  myoxus-data-view-kanban-card .card-header-title {
    font-size: var(--data-view-cell-text-size);
    line-height: var(--data-view-cell-text-line-height);
  }

  myoxus-data-view-kanban-card .card-header-icon {
    padding: ${unsafeCSSValue("var(--mantine-spacing-xs)")};
    background-color: var(--myoxus-background-secondary-color);
    display: flex;
    align-items: center;
    border-radius: ${unsafeCSSValue("var(--mantine-radius-sm)")};
    width: max-content;
  }

  myoxus-data-view-kanban-card .card-header-icon svg {
    width: ${unsafeCSSValue("var(--mantine-spacing-lg)")};
    height: ${unsafeCSSValue("var(--mantine-spacing-lg)")};
    fill: var(--myoxus-icon-color);
    color: var(--myoxus-icon-color);
  }

  myoxus-data-view-kanban-card .card-body {
    display: flex;
    flex-direction: column;
    min-height: 0;
    padding: ${unsafeCSSValue("var(--mantine-spacing-sm)")};
    gap: ${unsafeCSSValue("var(--mantine-spacing-xs)")};
  }

  myoxus-data-view-kanban-card:hover .card-ops {
    visibility: visible;
  }
  myoxus-data-view-kanban-card:has(.active) .card-ops {
    visibility: visible;
  }

  myoxus-data-view-kanban-card:has([data-editing="true"]) .card-ops {
    visibility: hidden;
  }

  .card-ops {
    position: absolute;
    right: ${unsafeCSSValue("var(--mantine-spacing-sm)")};
    top: ${unsafeCSSValue("var(--mantine-spacing-sm)")};
    visibility: hidden;
    display: flex;
    gap: ${unsafeCSSValue("var(--mantine-spacing-xs)")};
    cursor: pointer;
  }

  .card-op {
    display: flex;
    position: relative;
    padding: ${unsafeCSSValue("var(--mantine-spacing-xs)")};
    border-radius: ${unsafeCSSValue("var(--mantine-radius-sm)")};
    box-shadow: ${unsafeCSSValue("var(--mantine-shadow-sm)")};
    background-color: var(--myoxus-background-primary-color);
  }

  .card-op:hover:before {
    content: "";
    border-radius: ${unsafeCSSValue("var(--mantine-radius-sm)")};
    position: absolute;
    left: 0;
    right: 0;
    top: 0;
    bottom: 0;
    background-color: ${unsafeCSS(cssVar("hoverColor"))};
  }

  .card-op svg {
    fill: var(--myoxus-icon-color);
    color: var(--myoxus-icon-color);
    width: ${unsafeCSSValue("var(--mantine-spacing-lg)")};
    height: ${unsafeCSSValue("var(--mantine-spacing-lg)")};
  }
`;

export class KanbanCard extends SignalWatcher(
  WithDisposable(ShadowlessElement),
) {
  static override styles = styles;

  private readonly clickEdit = (e: MouseEvent) => {
    e.stopPropagation();
    const selection = this.getSelection();
    if (selection) {
      openDetail(this.kanbanViewLogic, this.cardId, selection);
    }
  };

  private readonly clickMore = (e: MouseEvent) => {
    e.stopPropagation();
    const selection = this.getSelection();
    const ele = e.currentTarget as HTMLElement;
    if (selection) {
      selection.selection = {
        selectionType: "card",
        cards: [
          {
            groupKey: this.groupKey,
            cardId: this.cardId,
          },
        ],
      };
      popCardMenu(
        this.kanbanViewLogic,
        popupTargetFromElement(ele),
        this.cardId,
        selection,
      );
    }
  };

  private readonly contextMenu = (e: MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const selection = this.getSelection();
    if (selection) {
      selection.selection = {
        selectionType: "card",
        cards: [
          {
            groupKey: this.groupKey,
            cardId: this.cardId,
          },
        ],
      };
      const target = e.target as HTMLElement;
      const ref = target.closest("myoxus-data-view-kanban-cell") ?? this;
      popCardMenu(
        this.kanbanViewLogic,
        popupTargetFromElement(ref),
        this.cardId,
        selection,
      );
    }
  };

  private getSelection() {
    return this.kanbanViewLogic.selectionController;
  }

  private getAccessibleLabel() {
    const title = this.view.getHeaderTitle(this.cardId);
    return (
      kanbanAccessibleText(
        title?.stringValueGet(this.cardId) ??
          title?.cellGetOrCreate(this.cardId).value$.value,
      ) ||
      kanbanAccessibleText(
        this.querySelector(".card-header-title")?.textContent,
      )
    );
  }

  private observeAccessibleLabel() {
    if (typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver(() => {
      this.syncAccessibilityAttributes();
    });
    observer.observe(this, {
      characterData: true,
      childList: true,
      subtree: true,
    });
    this._disposables.add(() => observer.disconnect());
  }

  private syncAccessibilityAttributes() {
    if (!this.kanbanViewLogic || !this.cardId) return;
    const label = this.getAccessibleLabel();
    if (label) {
      this.setAttribute("aria-label", label);
    } else {
      this.removeAttribute("aria-label");
    }
    this.setAttribute("aria-selected", this.isFocus$.value ? "true" : "false");
    this.setAttribute("role", "listitem");
  }

  private renderBody(columns: KanbanColumn[]) {
    if (columns.length === 0) {
      return "";
    }
    return html` <div class="card-body">
      ${repeat(
        columns,
        (v) => v.id,
        (column) => {
          if (this.view.isInHeader(column.id)) {
            return "";
          }
          return html` <myoxus-data-view-kanban-cell
            .contentOnly="${false}"
            data-column-id="${column.id}"
            .groupKey="${this.groupKey}"
            .column="${column}"
            .cardId="${this.cardId}"
            .kanbanViewLogic="${this.kanbanViewLogic}"
          ></myoxus-data-view-kanban-cell>`;
        },
      )}
    </div>`;
  }

  private renderHeader(columns: KanbanColumn[]) {
    if (!this.view.hasHeader(this.cardId)) {
      return "";
    }
    const classList = classMap({
      "card-header": true,
      "has-divider": columns.length > 0,
    });
    return html`
      <div class="${classList}">${this.renderTitle()} ${this.renderIcon()}</div>
    `;
  }

  private renderIcon() {
    const icon = this.view.getHeaderIcon(this.cardId);
    if (!icon) {
      return;
    }
    return html` <div class="card-header-icon">
      ${icon.cellGetOrCreate(this.cardId).value$.value}
    </div>`;
  }

  private renderOps() {
    if (this.view.readonly$.value) {
      return;
    }
    return html`
      <div class="card-ops">
        <div class="card-op" @click="${this.clickEdit}">
          ${CenterPeekIcon()}
        </div>
        <div class="card-op" @click="${this.clickMore}">
          ${MoreHorizontalIcon()}
        </div>
      </div>
    `;
  }

  private renderTitle() {
    const title = this.view.getHeaderTitle(this.cardId);
    if (!title) {
      return;
    }
    return html` <div class="card-header-title">
      <myoxus-data-view-kanban-cell
        .contentOnly="${true}"
        data-column-id="${title.id}"
        .kanbanViewLogic="${this.kanbanViewLogic}"
        .groupKey="${this.groupKey}"
        .column="${title}"
        .cardId="${this.cardId}"
      ></myoxus-data-view-kanban-cell>
    </div>`;
  }

  override connectedCallback() {
    super.connectedCallback();
    this.observeAccessibleLabel();
    if (this.view.readonly$.value) {
      return;
    }
    this._disposables.addFromEvent(this, "contextmenu", (e) => {
      this.contextMenu(e);
    });
    this._disposables.addFromEvent(this, "click", (e) => {
      if (e.shiftKey) {
        this.getSelection()?.shiftClickCard(e);
        return;
      }
      const selection = this.getSelection();
      const preSelection = selection?.selection;

      if (preSelection?.selectionType !== "card") return;

      if (selection) {
        selection.selection = undefined;
      }
      this.kanbanViewLogic.root.openDetailPanel({
        view: this.view,
        rowId: this.cardId,
        onClose: () => {
          if (selection) {
            selection.selection = preSelection;
          }
        },
      });
    });
  }

  protected override updated() {
    this.syncAccessibilityAttributes();
  }

  override render() {
    const columns = this.view.properties$.value.filter(
      (v) => !this.view.isInHeader(v.id),
    );
    this.style.border = this.isFocus$.value
      ? "1px solid var(--myoxus-primary-color)"
      : "";
    return html`
      ${this.renderHeader(columns)} ${this.renderBody(columns)}
      ${this.renderOps()}
    `;
  }

  @property({ attribute: false })
  accessor cardId!: string;

  @property({ attribute: false })
  accessor groupKey!: string;

  isFocus$ = signal(false);

  @property({ attribute: false })
  accessor kanbanViewLogic!: KanbanViewUILogic;

  get view() {
    return this.kanbanViewLogic.view;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "myoxus-data-view-kanban-card": KanbanCard;
  }
}
