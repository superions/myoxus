import { menu } from "@virgultum/components/context-menu";
import { html } from "lit/static-html.js";

import { renderUniLit } from "../utils/uni-component/index.js";
import type { Property } from "../view-manager/property.js";

export const inputConfig = (property: Property) => {
  return menu.input({
    prefix: html`
      <div class="myoxus-database-column-type-menu-icon">
        ${renderUniLit(property.icon)}
      </div>
    `,
    initialValue: property.name$.value,
    placeholder: "Property name",
    onBlur: (text) => {
      property.nameSet(text);
    },
  });
};
export const typeConfig = (property: Property) => {
  const typePreviewStyle = [
    "color: var(--myoxus-text-secondary-color)",
    `gap: var(--mantine-spacing-xs)`,
    `font-size: var(--mantine-font-size-nav, var(--mantine-font-size-md))`,
    `line-height: var(--mantine-line-height-nav, var(--mantine-line-height-md))`,
  ].join(";");

  return menu.group({
    items: [
      menu.subMenu({
        name: "Type",
        hide: () => !property.typeCanSet,
        postfix: html` <div
          class="myoxus-database-column-type-icon"
          style="${typePreviewStyle}"
        >
          ${renderUniLit(property.icon)}
          ${
            property.view.propertyMetas$.value.find(
              (v) => v.type === property.type$.value,
            )?.config.name
          }
        </div>`,
        options: {
          title: {
            text: "Property type",
          },
          items: [
            menu.group({
              items: property.view.propertyMetas$.value.map((config) => {
                return menu.action({
                  isSelected: config.type === property.type$.value,
                  name: config.config.name,
                  prefix: renderUniLit(config.renderer.icon),
                  select: () => {
                    if (property.type$.value === config.type) {
                      return;
                    }
                    property.typeSet?.(config.type);
                  },
                });
              }),
            }),
          ],
        },
      }),
    ],
  });
};
