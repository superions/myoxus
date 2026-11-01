import {
  menu,
  popMenu,
  popupTargetFromElement,
} from "@virgultum/components/context-menu";
import { SignalWatcher, WithDisposable } from "@virgultum/global/lit";
import { unsafeCSSValue } from "@virgultum/shared/theme";
import { ShadowlessElement } from "@virgultum/std";
import { css } from "lit";
import { property } from "lit/decorators.js";
import { html } from "lit/static-html.js";

import { groupTraitKey } from "../../../core/group-by/trait.js";
import type { SingleView } from "../../../core/index.js";
import { canGroupable } from "../group-by-utils.js";

const styles = css`
  myoxus-data-view-kanban-header {
    display: flex;
    justify-content: space-between;
    padding: ${unsafeCSSValue("var(--mantine-spacing-xs)")};
    flex-shrink: 0;
  }

  .select-group {
    border-radius: ${unsafeCSSValue("var(--mantine-radius-lg)")};
    padding: ${unsafeCSSValue("var(--mantine-spacing-xs)")}
      ${unsafeCSSValue("var(--mantine-spacing-sm)")};
    cursor: pointer;
  }

  .select-group:hover {
    background-color: var(--myoxus-hover-color);
  }
`;

export class KanbanHeader extends SignalWatcher(
  WithDisposable(ShadowlessElement),
) {
  static override styles = styles;

  private readonly clickGroup = (e: MouseEvent) => {
    const groupTrait = this.view.traitGet(groupTraitKey);
    if (!groupTrait) {
      return;
    }
    popMenu(popupTargetFromElement(e.target as HTMLElement), {
      options: {
        items: this.view.properties$.value
          .filter((column) => {
            if (column.id === groupTrait.property$.value?.id) {
              return false;
            }
            return canGroupable(this.view.manager.dataSource, column.id);
          })
          .map((column) => {
            return menu.action({
              name: column.name$.value,
              select: () => {
                groupTrait.changeGroup(column.id);
              },
            });
          }),
      },
    });
  };

  override render() {
    return html`
      <div></div>
      <div>
        <div class="select-group" @click="${this.clickGroup}">Group</div>
      </div>
    `;
  }

  @property({ attribute: false })
  accessor view!: SingleView;
}

declare global {
  interface HTMLElementTagNameMap {
    "myoxus-data-view-kanban-header": KanbanHeader;
  }
}
