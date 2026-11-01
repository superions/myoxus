import { IS_MOBILE } from "@virgultum/global/env";
import { unsafeCSSVar } from "@virgultum/shared/theme";
import { html, type TemplateResult } from "lit";

import type { MenuConfig } from "./menu.js";
import type { MenuItemRender } from "./types.js";

export const menuGroupItems = {
  group: (config: { name?: string; items: MenuConfig[] }) => (menu, index) => {
    const items = menu.renderItems(config.items);
    if (!items.length) {
      return;
    }
    if (IS_MOBILE) {
      return html` <div
        style="
          display: flex;
          flex-direction: column;
          background-color: ${unsafeCSSVar("backgroundPrimaryColor")};
          padding: 4px;
          border-radius: 12px;
"
      >
        ${items}
      </div>`;
    }
    const result: TemplateResult = html` ${
        index === 0
          ? ""
          : html` <div
              style="height: 0.5px;background-color: var(--myoxus-divider-color);margin: 4px 0"
            ></div>`
      }
      <div style="display: flex;flex-direction: column;gap:4px">${items}</div>`;
    return result;
  },
} satisfies Record<string, MenuItemRender<never>>;
