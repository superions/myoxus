import type { Middleware } from "@floating-ui/dom";
import { InvisibleIcon, ViewIcon } from "@myoxus/icons/lit";
import { cssVar } from "@myoxus/theme";
import { computed } from "@preact/signals-core";
import {
  menu,
  popMenu,
  type PopupTarget,
} from "@virgultum/components/context-menu";
import { SignalWatcher, WithDisposable } from "@virgultum/global/lit";
import { unsafeCSSValue } from "@virgultum/shared/theme";
import { ShadowlessElement } from "@virgultum/std";
import { css, html, unsafeCSS } from "lit";
import { property, query } from "lit/decorators.js";
import { classMap } from "lit/directives/class-map.js";
import { repeat } from "lit/directives/repeat.js";

import { dragHandler } from "../utils/wc-dnd/dnd-context.js";
import { defaultActivators } from "../utils/wc-dnd/sensors/index.js";
import {
  createSortContext,
  sortable,
} from "../utils/wc-dnd/sort/sort-context.js";
import { verticalListSortingStrategy } from "../utils/wc-dnd/sort/strategies/index.js";
import type { Property } from "../view-manager/property.js";
import type { SingleView } from "../view-manager/single-view.js";

export class DataViewPropertiesSettingView extends SignalWatcher(
  WithDisposable(ShadowlessElement),
) {
  static override styles = css`
    .properties-group-header {
      user-select: none;
      padding: ${unsafeCSSValue("var(--mantine-spacing-xs)")}
        ${unsafeCSSValue("var(--mantine-spacing-md)")}
        ${unsafeCSSValue("var(--mantine-spacing-md)")}
        ${unsafeCSSValue("var(--mantine-spacing-md)")};
      margin-bottom: ${unsafeCSSValue("var(--mantine-spacing-md)")};
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid ${unsafeCSS(cssVar("borderColor"))};
    }

    .properties-group-title {
      font-size: ${unsafeCSSValue(
        "var(--mantine-font-size-section, var(--mantine-font-size-md))",
      )};
      line-height: ${unsafeCSSValue(
        "var(--mantine-line-height-section, var(--mantine-line-height-md))",
      )};
      font-weight: ${unsafeCSSValue(
        "var(--mantine-font-weight-section, var(--mantine-font-weight-regular))",
      )};
      color: var(--myoxus-text-secondary-color);
      display: flex;
      align-items: center;
      gap: ${unsafeCSSValue("var(--mantine-spacing-sm)")};
    }

    .properties-group-op {
      padding: ${unsafeCSSValue("var(--mantine-spacing-xs)")}
        ${unsafeCSSValue("var(--mantine-spacing-sm)")};
      font-size: ${unsafeCSSValue(
        "var(--mantine-font-size-section, var(--mantine-font-size-md))",
      )};
      line-height: ${unsafeCSSValue(
        "var(--mantine-line-height-section, var(--mantine-line-height-md))",
      )};
      font-weight: ${unsafeCSSValue(
        "var(--mantine-font-weight-section, var(--mantine-font-weight-regular))",
      )};
      border-radius: ${unsafeCSSValue("var(--mantine-radius-xs)")};
      cursor: pointer;
      color: ${unsafeCSS(cssVar("primaryColor"))};
    }

    .properties-group-op:hover {
      background-color: var(--myoxus-hover-color);
    }

    .properties-group {
      min-height: ${unsafeCSSValue(
        "calc(var(--mantine-spacing-2xl) + var(--mantine-spacing-sm))",
      )};
    }

    .property-item {
      padding: ${unsafeCSSValue("var(--mantine-spacing-xs)")};
      display: flex;
      align-items: center;
      gap: ${unsafeCSSValue("var(--mantine-spacing-sm)")};
      user-select: none;
      cursor: pointer;
      border-radius: ${unsafeCSSValue("var(--mantine-radius-xs)")};
    }

    .property-item-drag-bar {
      width: ${unsafeCSSValue("var(--mantine-spacing-xs)")};
      height: ${unsafeCSSValue("var(--mantine-spacing-md)")};
      border-radius: ${unsafeCSSValue("var(--mantine-radius-xs)")};
      background-color: var(--myoxus-divider-color);
    }

    .property-item:hover .property-item-drag-bar {
      background-color: var(--myoxus-border-color);
    }

    .property-item-icon {
      display: flex;
      align-items: center;
    }

    .property-item-icon svg {
      color: var(--myoxus-icon-color);
      fill: var(--myoxus-icon-color);
      width: ${unsafeCSSValue(
        "calc(var(--mantine-spacing-lg) + var(--mantine-spacing-xs))",
      )};
      height: ${unsafeCSSValue(
        "calc(var(--mantine-spacing-lg) + var(--mantine-spacing-xs))",
      )};
    }

    .property-item-op-icon {
      display: flex;
      align-items: center;
      border-radius: ${unsafeCSSValue("var(--mantine-radius-xs)")};
    }

    .property-item-op-icon:hover {
      background-color: var(--myoxus-hover-color);
    }

    .property-item-op-icon.disabled:hover {
      background-color: transparent;
    }

    .property-item-op-icon svg {
      fill: var(--myoxus-icon-color);
      color: var(--myoxus-icon-color);
      width: ${unsafeCSSValue(
        "calc(var(--mantine-spacing-lg) + var(--mantine-spacing-xs))",
      )};
      height: ${unsafeCSSValue(
        "calc(var(--mantine-spacing-lg) + var(--mantine-spacing-xs))",
      )};
    }

    .property-item-op-icon.disabled svg {
      fill: var(--myoxus-text-disable-color);
      color: var(--myoxus-text-disable-color);
    }

    .property-item-name {
      font-size: ${unsafeCSSValue(
        "var(--mantine-font-size-nav, var(--mantine-font-size-md))",
      )};
      line-height: ${unsafeCSSValue(
        "var(--mantine-line-height-nav, var(--mantine-line-height-md))",
      )};
      font-weight: ${unsafeCSSValue(
        "var(--mantine-font-weight-nav, var(--mantine-font-weight-regular))",
      )};
      flex: 1;
    }
  `;

  @property({ attribute: false })
  accessor view!: SingleView;

  items$ = computed(() => {
    return this.view.propertiesRaw$.value.map((property) => property.id);
  });

  renderProperty = (property: Property) => {
    const icon = property.hide$.value ? InvisibleIcon() : ViewIcon();
    const changeVisible = () => {
      if (property.hideCanSet) {
        property.hideSet(!property.hide$.value);
      }
    };
    const classList = classMap({
      "property-item-op-icon": true,
      disabled: !property.hideCanSet,
    });
    return html` <div
      ${dragHandler(property.id)}
      ${sortable(property.id)}
      class="property-item"
    >
      <div class="property-item-drag-bar"></div>
      <uni-lit class="property-item-icon" .uni="${property.icon}"></uni-lit>
      <div class="property-item-name">${property.name$.value}</div>
      <div class="${classList}" @click="${changeVisible}">${icon}</div>
    </div>`;
  };

  sortContext = createSortContext({
    activators: defaultActivators,
    container: this,
    onDragEnd: (evt) => {
      const over = evt.over;
      const activeId = evt.active.id;
      if (over && over.id !== activeId) {
        const properties = this.items$.value;
        const activeIndex = properties.findIndex((id) => id === activeId);
        const overIndex = properties.findIndex((id) => id === over.id);

        this.view.propertyGetOrCreate(activeId).move(
          activeIndex > overIndex
            ? {
                before: true,
                id: over.id,
              }
            : {
                before: false,
                id: over.id,
              },
        );
      }
    },
    modifiers: [
      ({ transform }) => {
        return {
          ...transform,
          x: 0,
        };
      },
    ],
    items: this.items$,
    strategy: verticalListSortingStrategy,
  });

  private itemsGroup() {
    return this.view.propertiesRaw$.value;
  }

  override connectedCallback() {
    super.connectedCallback();
    this._disposables.addFromEvent(this, "pointerdown", (e) => {
      e.stopPropagation();
    });
  }

  override render() {
    const items = this.itemsGroup();
    return html`
      <div class="properties-group">
        ${repeat(items, (v) => v.id, this.renderProperty)}
      </div>
    `;
  }

  @query(".properties-group")
  accessor groupContainer!: HTMLElement;

  @property({ attribute: false })
  accessor onBack: (() => void) | undefined = undefined;
}

declare global {
  interface HTMLElementTagNameMap {
    "data-view-properties-setting": DataViewPropertiesSettingView;
  }
}

export const popPropertiesSetting = (
  target: PopupTarget,
  props: {
    view: SingleView;
    onClose?: () => void;
    onBack?: () => void;
  },
  middleware?: Array<Middleware | null | undefined | false>,
) => {
  const handler = popMenu(target, {
    middleware,
    options: {
      title: {
        text: "Properties",
        onBack: props.onBack,
        onClose: props.onClose,
        postfix: () => {
          const items = props.view.propertiesRaw$.value;
          const isAllShowed = items.every((property) => !property.hide$.value);
          const clickChangeAll = () => {
            items.forEach((property) => {
              if (property.hideCanSet) {
                property.hideSet(isAllShowed);
              }
            });
          };
          return html` <div
            class="properties-group-op"
            @click="${clickChangeAll}"
          >
            ${isAllShowed ? "Hide All" : "Show All"}
          </div>`;
        },
      },
      items: [
        menu.group({
          items: [
            () =>
              html` <data-view-properties-setting
                .view="${props.view}"
              ></data-view-properties-setting>`,
          ],
        }),
      ],
      onClose: props.onClose,
    },
  });
  handler.menu.menuElement.style.minHeight = "550px";

  // const view = new DataViewPropertiesSettingView();
  // view.view = props.view;
  // view.onBack = () => {
  //   close();
  //   props.onBack?.();
  // };
  // const close = createPopup(target, view, { onClose: props.onClose });
};
