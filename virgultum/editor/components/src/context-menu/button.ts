import {
  resolveEditorMessage,
  type EditorI18nMessage,
} from "@virgultum/shared/services";
import {
  CheckBoxCheckSolidIcon,
  CheckBoxUnIcon,
  DoneIcon,
} from "@myoxus/icons/lit";
import { cssVar } from "@myoxus/theme";
import type { ReadonlySignal } from "@preact/signals-core";
import { IS_MOBILE } from "@virgultum/global/env";
import { css, html, type TemplateResult, unsafeCSS } from "lit";
import { property } from "lit/decorators.js";
import { classMap } from "lit/directives/class-map.js";
import { keyed } from "lit/directives/keyed.js";
import type { ClassInfo } from "lit-html/directives/class-map.js";
import { ifDefined } from "lit-html/directives/if-defined.js";

import { MenuFocusable } from "./focusable.js";
import type { Menu } from "./menu.js";
import type { MenuClass, MenuItemRender } from "./types.js";

export type MenuButtonData = {
  disabled?: boolean;
  content: () => TemplateResult;
  class: ClassInfo;
  select: (ele: HTMLElement) => void | false;
  onHover?: (hover: boolean) => void;
  testId?: string;
  closeOnSelect?: boolean;
};

export class MenuButton extends MenuFocusable {
  static override styles = css`
    .myoxus-menu-button {
      display: flex;
      width: 100%;
      font-size: 20px;
      cursor: pointer;
      align-items: center;
      padding: 4px;
      gap: 8px;
      border-radius: 4px;
      color: var(--myoxus-icon-color);
    }

    .myoxus-menu-button:hover,
    myoxus-menu-button.active .myoxus-menu-button {
      background-color: var(--myoxus-hover-color);
    }

    .myoxus-menu-button .myoxus-menu-action-text {
      flex: 1;
      font-size: 14px;
      line-height: 22px;
      color: var(--myoxus-text-primary-color);
    }

    .myoxus-menu-button.focused {
      outline: 1px solid ${unsafeCSS(cssVar("primaryColor"))};
    }

    .myoxus-menu-button.delete-item:hover {
      background-color: var(--myoxus-background-error-color);
      color: var(--myoxus-error-color);
    }

    .myoxus-menu-button.delete-item:hover .myoxus-menu-action-text {
      color: var(--myoxus-error-color);
    }
  `;

  override connectedCallback() {
    super.connectedCallback();
    this.disposables.addFromEvent(this, "mouseenter", () => {
      this.data.onHover?.(true);
      this.menu.closeSubMenu();
    });
    this.disposables.addFromEvent(this, "mouseleave", () => {
      this.data.onHover?.(false);
    });
    this.disposables.addFromEvent(this, "click", this.onClick);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.data.onHover?.(false);
  }

  onClick() {
    if (this.data.disabled) return;
    if (this.data.select(this) !== false) {
      this.menu.options.onComplete?.();
      if (this.data.closeOnSelect !== false) {
        this.menu.close();
      }
    }
  }

  override onPressEnter() {
    this.onClick();
  }

  protected override render(): unknown {
    const classString = classMap({
      "myoxus-menu-button": true,
      focused: this.isFocused$.value,
      ...this.data.class,
    });
    return html` <div
      class="${classString}"
      data-testid=${ifDefined(this.data.testId)}
      aria-disabled=${this.data.disabled ? "true" : "false"}
    >
      ${this.data.content()}
    </div>`;
  }

  @property({ attribute: false })
  accessor data!: MenuButtonData;
}

export class MobileMenuButton extends MenuFocusable {
  static override styles = css`
    .mobile-menu-button {
      display: flex;
      width: 100%;
      cursor: pointer;
      align-items: center;
      font-size: 20px;
      padding: 11px 8px;
      gap: 8px;
      border-radius: 4px;
      color: var(--myoxus-icon-color);
    }

    .mobile-menu-button .myoxus-menu-action-text {
      flex: 1;
      color: var(--myoxus-text-primary-color);
      font-size: 17px;
      line-height: 22px;
    }

    .mobile-menu-button.delete-item {
      color: var(--myoxus-error-color);
    }

    .mobile-menu-button.delete-item .mobile-menu-action-text {
      color: var(--myoxus-error-color);
    }
  `;

  override connectedCallback() {
    super.connectedCallback();
    this.disposables.addFromEvent(this, "click", this.onClick);
  }

  onClick() {
    if (this.data.disabled) return;
    if (this.data.select(this) !== false) {
      this.menu.options.onComplete?.();
      if (this.data.closeOnSelect !== false) {
        this.menu.close();
      }
    }
  }

  override onPressEnter() {
    this.onClick();
  }

  protected override render(): unknown {
    const classString = classMap({
      "mobile-menu-button": true,
      focused: this.isFocused$.value,
      ...this.data.class,
    });
    return html` <div
      class="${classString}"
      data-testid=${ifDefined(this.data.testId)}
      aria-disabled=${this.data.disabled ? "true" : "false"}
    >
      ${this.data.content()}
    </div>`;
  }

  @property({ attribute: false })
  accessor data!: MenuButtonData;
}

const renderButton = (data: MenuButtonData, menu: Menu) => {
  if (IS_MOBILE) {
    return html`<mobile-menu-button
      .data="${data}"
      .menu="${menu}"
    ></mobile-menu-button>`;
  }
  return html`<myoxus-menu-button
    .data="${data}"
    .menu="${menu}"
  ></myoxus-menu-button>`;
};
export const menuButtonItems = {
  action:
    (config: {
      name: string;
      disabled?: boolean;
      label?: EditorI18nMessage | (() => TemplateResult);
      info?: TemplateResult;
      prefix?: TemplateResult;
      postfix?: TemplateResult;
      isSelected?: boolean;
      select: (ele: HTMLElement) => void | false;
      onHover?: (hover: boolean) => void;
      class?: MenuClass;
      closeOnSelect?: boolean;
      hide?: () => boolean;
      testId?: string;
    }) =>
    (menu) => {
      if (
        config.hide?.() ||
        !menu.search(
          config.name,
          typeof config.label === "function" ? undefined : config.label,
        )
      ) {
        return;
      }
      const data: MenuButtonData = {
        disabled: config.disabled,
        content: () => {
          return html`
            ${config.prefix}
            <div class="myoxus-menu-action-text">
              ${typeof config.label === "function" ? config.label() : config.label ? resolveEditorMessage(config.label, menu.options.i18n) : config.name}
              ${config.info}
            </div>
            ${config.postfix ?? (config.isSelected ? DoneIcon() : undefined)}
          `;
        },
        onHover: config.onHover,
        select: config.select,
        closeOnSelect: config.closeOnSelect,
        class: {
          "selected-item": config.isSelected ?? false,
          ...config.class,
        },
        testId: config.testId,
      };
      return renderButton(data, menu);
    },
  checkbox:
    (config: {
      name: string;
      checked: ReadonlySignal<boolean>;
      postfix?: TemplateResult;
      label?: EditorI18nMessage | (() => TemplateResult);
      select: (checked: boolean) => boolean;
      class?: ClassInfo;
      testId?: string;
    }) =>
    (menu) => {
      if (
        !menu.search(
          config.name,
          typeof config.label === "function" ? undefined : config.label,
        )
      ) {
        return;
      }
      const data: MenuButtonData = {
        content: () => html`
          ${
            config.checked.value
              ? CheckBoxCheckSolidIcon({ style: `color:#1E96EB` })
              : CheckBoxUnIcon()
          }
          <div class="myoxus-menu-action-text">
            ${typeof config.label === "function" ? config.label() : config.label ? resolveEditorMessage(config.label, menu.options.i18n) : config.name}
          </div>
          ${config.postfix}
        `,
        select: () => {
          config.select(config.checked.value);
          return false;
        },
        class: config.class ?? {},
        testId: config.testId,
      };
      return html`${keyed(config.name, renderButton(data, menu))}`;
    },
  toggleSwitch:
    (config: {
      name: string;
      on: boolean;
      prefix?: TemplateResult;
      postfix?: TemplateResult;
      label?: EditorI18nMessage | (() => TemplateResult);
      onChange: (on: boolean) => void;
      class?: ClassInfo;
      testId?: string;
    }) =>
    (menu) => {
      if (
        !menu.search(
          config.name,
          typeof config.label === "function" ? undefined : config.label,
        )
      ) {
        return;
      }
      const onChange = (on: boolean) => {
        config.onChange(on);
      };

      const data: MenuButtonData = {
        content: () => html`
          ${config.prefix}
          <div class="myoxus-menu-action-text">
            ${typeof config.label === "function" ? config.label() : config.label ? resolveEditorMessage(config.label, menu.options.i18n) : config.name}
          </div>
          <toggle-switch
            .on="${config.on}"
            .onChange="${onChange}"
          ></toggle-switch>
          ${config.postfix}
        `,
        select: () => {
          config.onChange(config.on);
          return false;
        },
        class: config.class ?? {},
        testId: config.testId,
      };
      return html`${keyed(config.name, renderButton(data, menu))}`;
    },
} satisfies Record<string, MenuItemRender<never>>;
