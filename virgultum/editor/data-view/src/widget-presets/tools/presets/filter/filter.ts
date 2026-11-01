import { FilterIcon } from "@myoxus/icons/lit";
import { cssVar } from "@myoxus/theme";
import { computed } from "@preact/signals-core";
import { popupTargetFromElement } from "@virgultum/components/context-menu";
import { IS_MOBILE } from "@virgultum/global/env";
import { css, html, nothing } from "lit";
import { styleMap } from "lit/directives/style-map.js";

import { popCreateFilter } from "../../../../core/filter/add-filter.js";
import { filterTraitKey } from "../../../../core/filter/trait.js";
import type { FilterGroup } from "../../../../core/filter/types.js";
import { emptyFilterGroup } from "../../../../core/filter/utils.js";
import { WidgetBase } from "../../../../core/widget/widget-base.js";
import {
  createDefaultShowQuickSettingBar,
  ShowQuickSettingBarKey,
} from "../../../quick-setting-bar/context.js";

const styles = css`
  .myoxus-database-filter-button {
    display: flex;
    align-items: center;
    gap: 6px;
    line-height: 20px;
    padding: 2px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 20px;
  }

  .myoxus-database-filter-button:hover,
  .myoxus-database-filter-button.active {
    background-color: var(--myoxus-hover-color);
  }

  .myoxus-database-filter-button {
  }
`;

export class DataViewHeaderToolsFilter extends WidgetBase {
  static override styles = styles;

  hasFilter = computed(() => {
    return this.filterTrait?.hasFilter$.value ?? false;
  });

  private get _filter(): FilterGroup {
    return this.filterTrait?.filter$.value ?? emptyFilterGroup;
  }

  private set _filter(filter: FilterGroup) {
    this.filterTrait?.filterSet(filter);
  }

  get filterTrait() {
    return this.view.traitGet(filterTraitKey);
  }

  private get readonly() {
    return this.view.readonly$.value;
  }

  private clickFilter(event: MouseEvent) {
    if (this.hasFilter.value) {
      this.toggleShowFilter();
      return;
    }
    popCreateFilter(
      popupTargetFromElement(event.currentTarget as HTMLElement),
      {
        vars: this.view.vars$,
        onSelect: (filter) => {
          this._filter = {
            ...this._filter,
            conditions: [filter],
          };
          this.toggleShowFilter(true);
          this.dataViewLogic.eventTrace("CreateDatabaseFilter", {});
        },
      },
    );
    return;
  }

  override connectedCallback() {
    super.connectedCallback();
    this.style.display = IS_MOBILE ? "none" : "flex";
  }

  override render() {
    if (this.readonly) return nothing;
    const style = styleMap({
      color: this.hasFilter.value
        ? cssVar("textEmphasisColor")
        : cssVar("iconColor"),
    });
    return html` <div
      @click="${this.clickFilter}"
      style="${style}"
      class="myoxus-database-filter-button"
    >
      ${FilterIcon()}
    </div>`;
  }

  toggleShowFilter(show?: boolean) {
    const map = this.view.serviceGetOrCreate(
      ShowQuickSettingBarKey,
      createDefaultShowQuickSettingBar,
    );
    map.value = {
      ...map.value,
      [this.view.id]: show ?? !map.value[this.view.id],
    };
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "data-view-header-tools-filter": DataViewHeaderToolsFilter;
  }
}
