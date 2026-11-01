import { EditorChevronDown } from "@virgultum/components/toolbar";
import {
  EditorI18nProvider,
  type ToolbarContext,
  resolveEditorText,
} from "@virgultum/shared/services";
import type { BlockComponent } from "@virgultum/std";
import { html } from "lit";
import { ifDefined } from "lit/directives/if-defined.js";
import { repeat } from "lit/directives/repeat.js";

import type { Menu, MenuItem } from "./types";

export function renderCurrentMenuItemWith<T, F extends keyof MenuItem<T>>(
  items: MenuItem<T>[],
  currentValue: T,
  field: F,
) {
  return items.find(({ value }) => value === currentValue)?.[field];
}

export function renderMenu<T>(
  ctx: ToolbarContext,
  { label, tooltip, icon, items, currentValue, onPick }: Menu<T>,
) {
  const i18n = ctx.std.getOptional(EditorI18nProvider) ?? undefined;
  const localizedLabel = resolveEditorText(label, i18n) ?? label;
  const localizedTooltip = tooltip
    ? resolveEditorText(tooltip, i18n)
    : localizedLabel;
  return html`
    <editor-menu-button
      aria-label=${localizedLabel}
      .button=${html`
        <editor-icon-button
          aria-label="${localizedLabel}"
          .tooltip="${localizedTooltip}"
        >
          ${icon ?? renderCurrentMenuItemWith(items, currentValue, "icon")}
          ${EditorChevronDown}
        </editor-icon-button>
      `}
    >
      ${renderMenuItems(items, currentValue, onPick, i18n)}
    </editor-menu-button>
  `;
}

export function renderMenuItems<T>(
  items: MenuItem<T>[],
  currentValue: T,
  onPick: (value: T) => void,
  i18n?: Parameters<typeof resolveEditorText>[1],
) {
  return repeat(
    items,
    (item) => item.value,
    ({ key, value, icon, disabled }) => {
      const localizedKey = key ? resolveEditorText(key, i18n) : undefined;
      return html`
        <editor-icon-button
          aria-label="${ifDefined(localizedKey)}"
          .disabled=${ifDefined(disabled)}
          .tooltip="${ifDefined(localizedKey)}"
          .active="${currentValue === value}"
          .activeMode="${"background"}"
          @click=${() => onPick(value)}
        >
          ${icon}
        </editor-icon-button>
      `;
    },
  );
}

export function getRootBlock(ctx: ToolbarContext): BlockComponent | null {
  const rootModel = ctx.store.root;
  if (!rootModel) return null;

  return ctx.view.getBlock(rootModel.id);
}
