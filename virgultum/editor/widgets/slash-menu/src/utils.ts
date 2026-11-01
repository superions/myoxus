import type {
  EditorI18nMessage,
  EditorI18nService,
} from "@virgultum/shared/services";
import {
  EditorI18nProvider,
  resolveLegacyEditorText,
  resolveEditorMessage,
} from "@virgultum/shared/services";
import type {
  SlashMenuConfig,
  SlashMenuContext,
  SlashMenuItem,
  SlashMenuSubMenu,
} from "./types";

export function isSubMenuItem(item: SlashMenuItem): item is SlashMenuSubMenu {
  return "subMenu" in item;
}

export function getSlashMenuItemId(item: SlashMenuItem) {
  return item.id ?? item.name ?? "legacy-item";
}

const slashMenuIdPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/**
 * Validates only the migrated identity contract. Legacy name-only
 * entries retain their existing identity until their owning provider migrates.
 */
export function assertStableSlashMenuItemIdentities(
  items: SlashMenuItem[],
  ids = new Set<string>(),
) {
  const visit = (item: SlashMenuItem) => {
    if (item.label && !item.id) {
      throw new Error("Localized slash-menu items require a stable id");
    }
    if (item.id) {
      if (!slashMenuIdPattern.test(item.id)) {
        throw new Error(`Invalid slash-menu id: ${item.id}`);
      }
      if (ids.has(item.id)) {
        throw new Error(`Duplicate slash-menu id: ${item.id}`);
      }
      ids.add(item.id);
    }
    if (isSubMenuItem(item)) {
      assertStableSlashMenuItemIdentities(item.subMenu, ids);
    }
  };
  items.forEach(visit);
}

export function getSlashMenuI18n(
  context: SlashMenuContext,
): EditorI18nService | undefined {
  return context.std.getOptional(EditorI18nProvider) ?? undefined;
}

export function resolveSlashMenuText(
  value: EditorI18nMessage | string | undefined,
  i18n?: EditorI18nService,
) {
  if (value === undefined) return undefined;
  return typeof value === "string"
    ? resolveLegacyEditorText(value, i18n)
    : resolveEditorMessage(value, i18n);
}

export function getSlashMenuItemLabel(
  item: SlashMenuItem,
  i18n?: EditorI18nService,
) {
  return resolveSlashMenuText(item.label ?? item.name, i18n) ?? "";
}

export function getSlashMenuItemSearchTerms(
  item: SlashMenuItem,
  i18n?: EditorI18nService,
) {
  const label = item.label;
  const fallbackLabel = label?.fallback ?? item.name;
  const aliases = item.searchAlias ?? [];
  const terms = [
    label
      ? resolveEditorMessage(label, i18n)
      : resolveLegacyEditorText(item.name, i18n),
    fallbackLabel,
    ...aliases.map((alias) => resolveSlashMenuText(alias, i18n)),
  ].filter((value): value is string => Boolean(value));
  const seen = new Set<string>();
  const locale = i18n?.locale$.value;
  return terms.filter((term) => {
    const normalized = term.toLocaleLowerCase(locale);
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

/** Rank literal labels and word prefixes ahead of fuzzy aliases. */
export function getSlashMenuSearchScore(
  item: SlashMenuItem,
  query: string,
  i18n?: EditorI18nService,
): number {
  const normalize = (text: string) =>
    text.toLocaleLowerCase(i18n?.locale$.value);
  const needle = normalize(query);
  if (!needle) return 0;
  const label = normalize(getSlashMenuItemLabel(item, i18n));
  const score = (text: string) => {
    if (text === needle) return 4;
    if (text.startsWith(needle)) return 3.25;
    if (text.split(/[^\p{L}\p{N}]+/u).some((word) => word.startsWith(needle)))
      return 3;
    if (text.includes(needle)) return 2;
    return 0;
  };
  return Math.max(
    score(label) + (score(label) ? 0.5 : 0),
    ...getSlashMenuItemSearchTerms(item, i18n).map((term) =>
      score(normalize(term)),
    ),
  );
}

export function getSlashMenuGroupLabel(
  item: SlashMenuItem,
  i18n?: EditorI18nService,
) {
  if (!item.group) return "";
  const parsed = parseGroup(item.group);
  return resolveSlashMenuText(parsed.groupLabel, i18n) ?? "";
}

export function parseGroup(group: NonNullable<SlashMenuItem["group"]>) {
  if (typeof group !== "string") {
    return {
      groupIndex: group.order,
      groupId: group.id,
      groupLabel: group.label,
      itemIndex: group.itemOrder,
    };
  }

  const [groupIndex, groupAndItem] = group.split("_");
  const [groupName, itemIndex] = groupAndItem.split("@");
  return {
    groupIndex: parseInt(groupIndex),
    groupId: groupName,
    groupLabel: groupName,
    itemIndex: parseInt(itemIndex),
  };
}

function itemCompareFn(a: SlashMenuItem, b: SlashMenuItem) {
  if (a.group === undefined && b.group === undefined) return 0;
  if (a.group === undefined) return -1;
  if (b.group === undefined) return 1;

  const aGroup = parseGroup(a.group);
  const bGroup = parseGroup(b.group);
  const aGroupIndex = aGroup.groupIndex;
  const bGroupIndex = bGroup.groupIndex;
  if (aGroupIndex !== bGroupIndex) return aGroupIndex - bGroupIndex;

  if (aGroup.groupId !== bGroup.groupId) {
    return aGroup.groupId.localeCompare(bGroup.groupId);
  }

  const aItemIndex = aGroup.itemIndex;
  const bItemIndex = bGroup.itemIndex;
  if (isNaN(aGroupIndex)) return -1;
  if (isNaN(bGroupIndex)) return 1;
  if (isNaN(aItemIndex)) return -1;
  if (isNaN(bItemIndex)) return 1;

  return aItemIndex - bItemIndex;
}

export function buildSlashMenuItems(
  items: SlashMenuItem[],
  context: SlashMenuContext,
  transform?: (item: SlashMenuItem) => SlashMenuItem,
): SlashMenuItem[] {
  if (transform) items = items.map(transform);
  assertStableSlashMenuItemIdentities(items);

  const result = items
    .filter((item) => (item.when ? item.when(context) : true))
    .sort(itemCompareFn)
    .map((item) => {
      if (isSubMenuItem(item)) {
        return {
          ...item,
          subMenu: buildSlashMenuItems(item.subMenu, context),
        };
      } else {
        return { ...item };
      }
    });
  return result;
}

export function mergeSlashMenuConfigs(
  configs: Map<string, SlashMenuConfig>,
): SlashMenuConfig {
  return {
    items: (ctx) =>
      Array.from(configs.values()).flatMap(({ items }) =>
        typeof items === "function" ? items(ctx) : items,
      ),
    disableWhen: (ctx) =>
      configs
        .values()
        .map(({ disableWhen }) => disableWhen?.(ctx) ?? false)
        .some(Boolean),
  };
}

export function formatDate(date: Date) {
  // yyyy-mm-dd
  const year = date.getFullYear();
  const month = (date.getMonth() + 1).toString().padStart(2, "0");
  const day = date.getDate().toString().padStart(2, "0");
  const strTime = `${year}-${month}-${day}`;
  return strTime;
}

export function formatTime(date: Date) {
  const hours = date.getHours().toString().padStart(2, "0");
  const minutes = date.getMinutes().toString().padStart(2, "0");
  const strTime = `${formatDate(date)} ${hours}:${minutes}`;
  return strTime;
}
