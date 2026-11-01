import type { BlockStdScope } from "@virgultum/std";
import type {
  EditorI18nMessage,
  EditorI18nService,
} from "@virgultum/shared/services";
import type { BlockModel } from "@virgultum/store";
import type { MyoxusIconExportName } from "@myoxus/icons/names";

export type SlashMenuContext = {
  std: BlockStdScope;
  model: BlockModel;
};

export type SlashMenuText = EditorI18nMessage | string;

export type SlashMenuGroup = Readonly<{
  id: string;
  label: EditorI18nMessage;
  order: number;
  itemOrder: number;
}>;

export type LegacySlashMenuGroup = `${number}_${string}@${number}`;

export type SlashMenuTooltip = {
  shortcut?: string;
  caption: SlashMenuText;
};

type SlashMenuItemBase = {
  /** Stable identity for behavior, telemetry, selectors and tests. */
  id?: string;
  /** Localized display label. `name` remains only for excluded legacy items. */
  label?: EditorI18nMessage;
  name?: string;
  description?: SlashMenuText;
  icon?: MyoxusIconExportName;
  /**
   * This field defines sorting and grouping of menu items like VSCode.
   * The first number indicates the group index, the second number indicates the item index in the group.
   * The group name is the string between `_` and `@`.
   * You can find an example figure in https://code.visualstudio.com/api/references/contribution-points#menu-example
   */
  group?: SlashMenuGroup | LegacySlashMenuGroup;

  searchAlias?: SlashMenuText[];
  /**
   * The condition to show the menu item.
   */
  when?: (ctx: SlashMenuContext) => boolean;
};

export type SlashMenuActionItem = SlashMenuItemBase & {
  action: (ctx: SlashMenuContext) => void;
  tooltip?: SlashMenuTooltip;
  /**
   * The alias of the menu item for search.
   */
  searchAlias?: SlashMenuText[];
};

export type SlashMenuSubMenu = SlashMenuItemBase & {
  subMenu: SlashMenuItem[];
};

export type SlashMenuItem = SlashMenuActionItem | SlashMenuSubMenu;

export type SlashMenuConfig = {
  /**
   * The items in the slash menu. It can be generated dynamically with the context.
   */
  items: SlashMenuItem[] | ((ctx: SlashMenuContext) => SlashMenuItem[]);

  /**
   * Slash menu will not be triggered when the condition is true.
   */
  disableWhen?: (ctx: SlashMenuContext) => boolean;
};

export type SlashMenuI18n = EditorI18nService | undefined;
