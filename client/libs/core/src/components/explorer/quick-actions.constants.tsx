// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import type { I18nString } from "@myoxus/i18n";
import type { FC } from "react";

import {
  type QuickActionProps,
  QuickDelete,
  QuickDeletePermanently,
  QuickFavorite,
  QuickRestore,
  QuickSelect,
  QuickSplit,
  QuickTab,
} from "./docs-view/quick-actions";
import type { ExplorerDisplayPreference } from "./types";

interface QuickActionDescriptor {
  name: I18nString;
  Component: FC<QuickActionProps>;
  disabled?: boolean;
}

type PrefixedKeys<Obj extends object, Prefix extends string> = {
  [Key in keyof Obj]-?: Key extends `${Prefix}${string}` ? Key : never;
}[keyof Obj];

export type QuickActionKey = PrefixedKeys<ExplorerDisplayPreference, "quick">;

const QUICK_ACTION_REGISTRY: Record<QuickActionKey, QuickActionDescriptor> = {
  quickFavorite: {
    name: "com.myoxus.all-docs.quick-action.favorite",
    Component: QuickFavorite,
  },
  quickTrash: {
    name: "com.myoxus.all-docs.quick-action.trash",
    Component: QuickDelete,
  },
  quickSplit: {
    name: "com.myoxus.all-docs.quick-action.split",
    Component: QuickSplit,
    disabled: !BUILD_CONFIG.isElectron,
  },
  quickTab: {
    name: "com.myoxus.all-docs.quick-action.tab",
    Component: QuickTab,
  },
  quickSelect: {
    name: "com.myoxus.all-docs.quick-action.select",
    Component: QuickSelect,
  },
  quickDeletePermanently: {
    name: "com.myoxus.all-docs.quick-action.delete-permanently",
    Component: QuickDeletePermanently,
    disabled: true,
  },
  quickRestore: {
    name: "com.myoxus.all-docs.quick-action.restore",
    Component: QuickRestore,
    disabled: true,
  },
};

export const quickActions = (
  Object.entries(QUICK_ACTION_REGISTRY) as Array<
    [QuickActionKey, QuickActionDescriptor]
  >
).map(([key, descriptor]) => ({ key, ...descriptor }));

/** List rows already render a permanent leading selection checkbox. */
export const listQuickActions = quickActions.filter(
  (action) => action.key !== "quickSelect",
);

export type QuickAction = (typeof quickActions)[number];
