import { AddCursorIcon } from "@myoxus/icons/lit";
import {
  menu,
  popFilterableSimpleMenu,
  popupTargetFromElement,
} from "@virgultum/components/context-menu";
import { SignalWatcher, WithDisposable } from "@virgultum/global/lit";
import { unsafeCSSValue } from "@virgultum/shared/theme";
import { ShadowlessElement } from "@virgultum/std";
import { css, nothing } from "lit";
import { property } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import { html } from "lit/static-html.js";

import { GroupTitle } from "../../../core/group-by/group-title.js";
import type { Group } from "../../../core/group-by/trait.js";
import { dragHandler } from "../../../core/utils/wc-dnd/dnd-context.js";
import { kanbanAccessibleText } from "../kanban-accessibility.js";
import type { KanbanViewUILogic } from "./kanban-view-ui-logic.js";

const styles = css`
  myoxus-data-view-kanban-group {
    width: ${unsafeCSSValue("260px")};
    flex-shrink: 0;
    border-radius: ${unsafeCSSValue("var(--mantine-radius-lg)")};
    display: flex;
    flex-direction: column;
    min-height: 0;
  }

  .group-header {
    min-height: ${unsafeCSSValue(
      "calc(var(--mantine-spacing-2xl) + var(--mantine-spacing-2xs))",
    )};
    padding: ${unsafeCSSValue(
      "calc(var(--mantine-spacing-2xs) + var(--mantine-spacing-xs))",
    )}
      ${unsafeCSSValue("var(--mantine-spacing-xs)")};
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: ${unsafeCSSValue("var(--mantine-spacing-sm)")};
    overflow: hidden;
    flex-shrink: 0;
  }

  .group-header-title {
    overflow: hidden;
    display: flex;
    align-items: center;
    gap: ${unsafeCSSValue("var(--mantine-spacing-sm)")};
    font-size: var(--data-view-cell-text-size);
  }

  myoxus-data-view-kanban-group:hover .group-header-op {
    visibility: visible;
    opacity: 1;
  }

  .group-body {
    margin-top: ${unsafeCSSValue("var(--mantine-spacing-xs)")};
    display: flex;
    flex-direction: column;
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 0 ${unsafeCSSValue("var(--mantine-spacing-xs)")}
      ${unsafeCSSValue("var(--mantine-spacing-xs)")};
    gap: ${unsafeCSSValue("var(--mantine-spacing-md)")};
  }

  .add-card {
    display: flex;
    align-items: center;
    padding: ${unsafeCSSValue("var(--mantine-spacing-xs)")};
    border-radius: ${unsafeCSSValue("var(--mantine-radius-sm)")};
    cursor: pointer;
    font-size: var(--data-view-cell-text-size);
    line-height: var(--data-view-cell-text-line-height);
    visibility: hidden;
    opacity: 0;
    transition: all 150ms cubic-bezier(0.42, 0, 1, 1);
    color: var(--myoxus-text-secondary-color);
  }

  myoxus-data-view-kanban-group:hover .add-card {
    visibility: visible;
    opacity: 1;
  }

  myoxus-data-view-kanban-group .add-card:hover {
    background-color: var(--myoxus-hover-color);
    color: var(--myoxus-text-primary-color);
  }

  .add-card-icon {
    align-items: center;
    display: flex;
    height: ${unsafeCSSValue("var(--mantine-spacing-lg)")};
    margin-right: ${unsafeCSSValue("var(--mantine-spacing-xs)")};
    width: ${unsafeCSSValue("var(--mantine-spacing-lg)")};
  }

  .sortable-ghost {
    background-color: var(--myoxus-hover-color);
    opacity: 0.5;
  }

  .sortable-drag {
    background-color: var(--myoxus-background-primary-color);
  }
`;

export class KanbanGroup extends SignalWatcher(
  WithDisposable(ShadowlessElement),
) {
  static override styles = styles;

  private readonly clickAddCard = () => {
    const id = this.view.addCard("end", this.group.key);
    requestAnimationFrame(() => {
      const columnId =
        this.view.mainProperties$.value.titleColumn ||
        this.view.propertyIds$.value[0];
      if (!columnId) return;
      this.kanbanViewLogic.selectionController.selection = {
        selectionType: "cell",
        groupKey: this.group.key,
        cardId: id,
        columnId,
        isEditing: true,
      };
    });
    this.requestUpdate();
  };

  private readonly clickAddCardInStart = () => {
    const id = this.view.addCard("start", this.group.key);
    requestAnimationFrame(() => {
      const columnId =
        this.view.mainProperties$.value.titleColumn ||
        this.view.propertyIds$.value[0];
      if (!columnId) return;
      this.kanbanViewLogic.selectionController.selection = {
        selectionType: "cell",
        groupKey: this.group.key,
        cardId: id,
        columnId,
        isEditing: true,
      };
    });
    this.requestUpdate();
  };

  private readonly clickGroupOptions = (e: MouseEvent) => {
    const ele = e.currentTarget as HTMLElement;
    popFilterableSimpleMenu(popupTargetFromElement(ele), [
      menu.action({
        name: "Ungroup",
        hide: () => this.group.value == null,
        select: () => {
          this.group.rows.forEach((row) => {
            this.group.manager.removeFromGroup(row.rowId, this.group.key);
          });
          this.requestUpdate();
        },
      }),
      menu.action({
        name: "Delete Cards",
        select: () => {
          this.view.rowsDelete(this.group.rows.map((row) => row.rowId));
          this.requestUpdate();
        },
      }),
    ]);
  };

  private syncAccessibilityAttributes() {
    if (!this.group) return;
    const label =
      kanbanAccessibleText(this.group.name$.value) || this.group.key;
    this.setAttribute("aria-label", label);
    this.setAttribute("role", "list");
  }

  protected override updated() {
    this.syncAccessibilityAttributes();
  }

  override render() {
    const cards = this.group.rows;
    return html`
      <div class="group-header" ${dragHandler(this.group.key)}>
        ${GroupTitle(this.group, {
          readonly: this.view.readonly$.value,
          clickAdd: this.clickAddCardInStart,
          clickOps: this.clickGroupOptions,
        })}
      </div>
      <div class="group-body">
        ${repeat(
          cards,
          (row) => row.rowId,
          (row) => {
            return html`
              <myoxus-data-view-kanban-card
                data-card-id="${row.rowId}"
                .groupKey="${this.group.key}"
                .kanbanViewLogic="${this.kanbanViewLogic}"
                .cardId="${row.rowId}"
              ></myoxus-data-view-kanban-card>
            `;
          },
        )}
        ${
          this.view.readonly$.value
            ? nothing
            : html`<div class="add-card" @click="${this.clickAddCard}">
                <div class="add-card-icon">${AddCursorIcon()}</div>
                Add
              </div>`
        }
      </div>
    `;
  }

  @property({ attribute: false })
  accessor group!: Group;

  @property({ attribute: false })
  accessor kanbanViewLogic!: KanbanViewUILogic;

  get view() {
    return this.kanbanViewLogic.view;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "myoxus-data-view-kanban-group": KanbanGroup;
  }
}
