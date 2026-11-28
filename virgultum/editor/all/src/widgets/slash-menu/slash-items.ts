// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import type {
  EditorI18nMessage,
  EditorI18nService,
} from "@virgultum/core/services";
import {
  EditorI18nProvider,
  resolveEditorMessage,
  resolveLegacyEditorText,
} from "@virgultum/core/services";
import type {
  SlashMenuConfig,
  SlashMenuContext,
  SlashMenuItem,
  SlashMenuSubMenu,
} from "@virgultum/core/slash-menu";

const STABLE_ITEM_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const WORD_SPLIT_PATTERN = /[^\p{L}\p{N}]+/u;

export interface ParsedSlashMenuGroup {
  groupIndex: number;
  groupId: string;
  groupLabel: EditorI18nMessage | string;
  itemIndex: number;
}

export function isSubMenuItem(item: SlashMenuItem): item is SlashMenuSubMenu {
  return "subMenu" in item;
}

export function getSlashMenuItemId(item: SlashMenuItem): string {
  return item.id ?? item.name ?? "legacy-item";
}

/**
 * Validates that localized slash-menu entries carry unique kebab-case IDs.
 * Legacy name-only entries remain valid until their owning provider migrates.
 */
export function assertStableSlashMenuItemIdentities(
  items: SlashMenuItem[],
  seenIds = new Set<string>(),
): void {
  for (const item of items) {
    if (item.label && !item.id) {
      throw new Error("Localized slash-menu items require a stable id");
    }
    if (item.id) {
      if (!STABLE_ITEM_ID.test(item.id)) {
        throw new Error(`Invalid slash-menu id: ${item.id}`);
      }
      if (seenIds.has(item.id)) {
        throw new Error(`Duplicate slash-menu id: ${item.id}`);
      }
      seenIds.add(item.id);
    }
    if (isSubMenuItem(item)) {
      assertStableSlashMenuItemIdentities(item.subMenu, seenIds);
    }
  }
}

export function getSlashMenuI18n(
  context: SlashMenuContext,
): EditorI18nService | undefined {
  return context.std.getOptional(EditorI18nProvider) ?? undefined;
}

export function resolveSlashMenuText(
  value: EditorI18nMessage | string | undefined,
  i18n?: EditorI18nService,
): string | undefined {
  if (value === undefined) return undefined;
  return typeof value === "string"
    ? resolveLegacyEditorText(value, i18n)
    : resolveEditorMessage(value, i18n);
}

export function getSlashMenuItemLabel(
  item: SlashMenuItem,
  i18n?: EditorI18nService,
): string {
  return resolveSlashMenuText(item.label ?? item.name, i18n) ?? "";
}

export function getSlashMenuItemSearchTerms(
  item: SlashMenuItem,
  i18n?: EditorI18nService,
): string[] {
  const locale = i18n?.locale$.value;
  const candidates: Array<string | undefined> = [
    item.label
      ? resolveEditorMessage(item.label, i18n)
      : resolveLegacyEditorText(item.name, i18n),
    item.label?.fallback ?? item.name,
    ...(item.searchAlias ?? []).map((alias) =>
      resolveSlashMenuText(alias, i18n),
    ),
  ];

  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate) continue;
    const normalized = candidate.toLocaleLowerCase(locale);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    deduped.push(candidate);
  }
  return deduped;
}

/** Rank exact and prefix label matches ahead of substring and alias hits. */
export function getSlashMenuSearchScore(
  item: SlashMenuItem,
  query: string,
  i18n?: EditorI18nService,
): number {
  const locale = i18n?.locale$.value;
  const normalize = (value: string) => value.toLocaleLowerCase(locale);
  const needle = normalize(query);
  if (!needle) return 0;

  const scoreMatch = (haystack: string): number => {
    if (haystack === needle) return 4;
    if (haystack.startsWith(needle)) return 3.25;
    if (haystack.split(WORD_SPLIT_PATTERN).some((w) => w.startsWith(needle))) {
      return 3;
    }
    if (haystack.includes(needle)) return 2;
    return 0;
  };

  const labelScore = scoreMatch(normalize(getSlashMenuItemLabel(item, i18n)));
  let best = labelScore > 0 ? labelScore + 0.5 : 0;

  for (const term of getSlashMenuItemSearchTerms(item, i18n)) {
    const score = scoreMatch(normalize(term));
    if (score > best) best = score;
  }
  return best;
}

export function parseGroup(
  group: NonNullable<SlashMenuItem["group"]>,
): ParsedSlashMenuGroup {
  if (typeof group !== "string") {
    return {
      groupIndex: group.order,
      groupId: group.id,
      groupLabel: group.label,
      itemIndex: group.itemOrder,
    };
  }

  const underscoreIndex = group.indexOf("_");
  const rawGroupOrder =
    underscoreIndex >= 0 ? group.slice(0, underscoreIndex) : group;
  const remainder =
    underscoreIndex >= 0 ? group.slice(underscoreIndex + 1) : "";
  const atIndex = remainder.indexOf("@");
  const groupName = atIndex >= 0 ? remainder.slice(0, atIndex) : remainder;
  const rawItemOrder = atIndex >= 0 ? remainder.slice(atIndex + 1) : "";

  return {
    groupIndex: Number.parseInt(rawGroupOrder, 10),
    groupId: groupName,
    groupLabel: groupName,
    itemIndex: Number.parseInt(rawItemOrder, 10),
  };
}

export function getSlashMenuGroupLabel(
  item: SlashMenuItem,
  i18n?: EditorI18nService,
): string {
  if (!item.group) return "";
  return resolveSlashMenuText(parseGroup(item.group).groupLabel, i18n) ?? "";
}

function compareSlashMenuItems(a: SlashMenuItem, b: SlashMenuItem): number {
  if (a.group === undefined && b.group === undefined) return 0;
  if (a.group === undefined) return -1;
  if (b.group === undefined) return 1;

  const left = parseGroup(a.group);
  const right = parseGroup(b.group);

  if (left.groupIndex !== right.groupIndex) {
    if (Number.isNaN(left.groupIndex)) return -1;
    if (Number.isNaN(right.groupIndex)) return 1;
    return left.groupIndex - right.groupIndex;
  }

  if (left.groupId !== right.groupId) {
    return left.groupId.localeCompare(right.groupId);
  }

  if (Number.isNaN(left.itemIndex)) return -1;
  if (Number.isNaN(right.itemIndex)) return 1;
  return left.itemIndex - right.itemIndex;
}

export function buildSlashMenuItems(
  items: SlashMenuItem[],
  context: SlashMenuContext,
  transform?: (item: SlashMenuItem) => SlashMenuItem,
): SlashMenuItem[] {
  const prepared = transform ? items.map(transform) : items;
  assertStableSlashMenuItemIdentities(prepared);

  return prepared
    .filter((item) => (item.when ? item.when(context) : true))
    .sort(compareSlashMenuItems)
    .map((item) =>
      isSubMenuItem(item)
        ? {
            ...item,
            subMenu: buildSlashMenuItems(item.subMenu, context),
          }
        : { ...item },
    );
}

export function mergeSlashMenuConfigs(
  configs: Map<string, SlashMenuConfig>,
): SlashMenuConfig {
  return {
    items: (context) => {
      const collected: SlashMenuItem[] = [];
      for (const config of configs.values()) {
        const entries =
          typeof config.items === "function"
            ? config.items(context)
            : config.items;
        collected.push(...entries);
      }
      return collected;
    },
    disableWhen: (context) => {
      for (const config of configs.values()) {
        if (config.disableWhen?.(context)) return true;
      }
      return false;
    },
  };
}
