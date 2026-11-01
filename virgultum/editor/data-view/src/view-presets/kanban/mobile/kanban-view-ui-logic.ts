import { AddCursorIcon } from "@myoxus/icons/lit";
import { signal } from "@preact/signals-core";
import {
  menu,
  popMenu,
  popupTargetFromElement,
} from "@virgultum/components/context-menu";
import { css } from "@virgultum/shared/styles";
import { unsafeCSSVar } from "@virgultum/shared/theme";
import type { InsertToPosition } from "@virgultum/shared/utils";
import type { TemplateResult } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { styleMap } from "lit/directives/style-map.js";
import { html } from "lit/static-html.js";

import {
  createUniComponentFromWebComponent,
  renderUniLit,
} from "../../../core/index.js";
import { sortable } from "../../../core/utils/wc-dnd/sort/sort-context.js";
import {
  DataViewUIBase,
  DataViewUILogicBase,
} from "../../../core/view/data-view-base.js";
import type { KanbanSingleView } from "../kanban-view-manager.js";
import type { KanbanViewSelectionWithType } from "../selection";
import { PAGE_VIEWPORT, type ViewportContext } from "../viewport-context.js";

const mobileKanbanViewWrapper = css({
  userSelect: "none",
  display: "flex",
  flexDirection: "column",
});

const mobileKanbanGroups = css({
  position: "relative",
  zIndex: 1,
  display: "flex",
  gap: "20px",
  paddingBottom: "4px",
  overflowX: "scroll",
  overflowY: "hidden",
});

const mobileAddGroup = css({
  height: "32px",
  flexShrink: 0,
  display: "flex",
  alignItems: "center",
  padding: "4px",
  borderRadius: "4px",
  fontSize: "16px",
  color: `var(${unsafeCSSVar("iconColor")})`,
});

export class MobileKanbanViewUILogic extends DataViewUILogicBase<
  KanbanSingleView,
  KanbanViewSelectionWithType
> {
  ui$ = signal<MobileKanbanViewUI | undefined>(undefined);

  /**
   * Liefert die aktuelle `ViewportContext` (P-VIRG-ARCH-E-02).
   *
   * Mobile: Page-Default. E-03 (Mobile Kanban) entscheidet, ob
   * Mobile ueberhaupt mit Edgeless-Skalierung umgehen muss.
   */
  override currentViewport(): ViewportContext {
    const provider = this.root.config.viewportProvider$?.value;
    if (!provider) return PAGE_VIEWPORT;
    const result = (provider as () => ViewportContext)();
    return result ?? PAGE_VIEWPORT;
  }

  private get readonly() {
    return this.view.readonly$.value;
  }

  clearSelection = () => {};

  addRow = (position: InsertToPosition) => {
    if (this.readonly) return;
    const id = this.view.rowAdd(position);
    this.ui$.value?.requestUpdate();
    return id;
  };

  focusFirstCell = () => {};

  showIndicator = (_evt: MouseEvent) => {
    return false;
  };

  hideIndicator = () => {};

  moveTo = () => {};

  get groupManager() {
    return this.view.groupTrait;
  }

  renderAddGroup = () => {
    if (this.readonly) {
      return;
    }
    const addGroup = this.groupManager.addGroup;
    if (!addGroup) {
      return;
    }
    const add = (e: MouseEvent) => {
      const ele = e.currentTarget as HTMLElement;
      popMenu(popupTargetFromElement(ele), {
        options: {
          items: [
            menu.input({
              onComplete: (text) => {
                const column = this.groupManager.property$.value;
                if (column) {
                  column.dataUpdate(() =>
                    addGroup({
                      text,
                      oldData: column.data$.value,
                      dataSource: this.view.manager.dataSource,
                    }),
                  );
                }
              },
            }),
          ],
        },
      });
    };
    return html` <div class="${mobileAddGroup}" @click="${add}">
      ${AddCursorIcon()}
    </div>`;
  };

  renderer = createUniComponentFromWebComponent(MobileKanbanViewUI);
}

export class MobileKanbanViewUI extends DataViewUIBase<MobileKanbanViewUILogic> {
  override connectedCallback(): void {
    super.connectedCallback();
    this.logic.ui$.value = this;
    this.classList.add(mobileKanbanViewWrapper);
  }

  override render(): TemplateResult {
    const groups = this.logic.groupManager.groupsDataList$.value;
    if (!groups) {
      return html``;
    }
    const groupEntries = groups.filter(
      (group): group is NonNullable<(typeof groups)[number]> => group != null,
    );
    const vPadding = this.logic.root.config.virtualPadding$.value;
    const wrapperStyle = styleMap({
      marginLeft: `-${vPadding}px`,
      marginRight: `-${vPadding}px`,
      paddingLeft: `${vPadding}px`,
      paddingRight: `${vPadding}px`,
    });
    return html`
      ${renderUniLit(this.logic.headerWidget, {
        dataViewLogic: this.logic,
      })}
      <div class="${mobileKanbanGroups}" style="${wrapperStyle}">
        ${repeat(
          groupEntries,
          (group) => group.key,
          (group) => {
            return html` <mobile-kanban-group
              ${sortable(group.key)}
              data-key="${group.key}"
              .kanbanViewLogic="${this.logic}"
              .group="${group}"
            ></mobile-kanban-group>`;
          },
        )}
        ${this.logic.renderAddGroup()}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "mobile-data-view-kanban-ui": MobileKanbanViewUI;
  }
}
