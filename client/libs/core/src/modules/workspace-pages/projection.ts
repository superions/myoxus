// SPDX-License-Identifier: AGPL-3.0-or-later

import { matchesDateFilterValue } from "@myoxus/core/modules/collection-rules/impls/filters/date";
import type {
  FilterParams,
  GroupByParams,
  OrderByParams,
} from "@myoxus/core/modules/collection-rules/types";

import type { DatabasePageRecord } from "./database-page-loader";
import { parseWorkspacePageKey, workspacePageKey } from "./identity";

export interface WorkspacePageGroup {
  items: string[];
  key: string;
}

export interface WorkspaceDocumentPageMetadata {
  createdAt?: number;
  id: string;
  title: string;
  updatedAt?: number;
}

const COMMON_PAGE_SYSTEM_KEYS = new Set([
  "createdAt",
  "favorite",
  "pageKind",
  "title",
  "updatedAt",
]);

function databaseMatchesFilter(
  database: DatabasePageRecord,
  filter: FilterParams,
  favorite: boolean,
): boolean {
  if (filter.type !== "system" || !COMMON_PAGE_SYSTEM_KEYS.has(filter.key)) {
    return false;
  }

  if (filter.key === "pageKind") {
    return filter.value === "all" || filter.value === "database";
  }
  if (filter.key === "favorite" && filter.method === "is") {
    return filter.value === "true" ? favorite : !favorite;
  }
  if (filter.key === "title" && filter.method === "match") {
    return database.title
      .toLocaleLowerCase()
      .includes((filter.value ?? "").toLocaleLowerCase());
  }
  if (filter.key === "createdAt" || filter.key === "updatedAt") {
    return matchesDateFilterValue(
      filter,
      filter.key === "createdAt" ? database.createdAt : database.updatedAt,
    );
  }
  return false;
}

function localDateKey(value: string | number | undefined): string {
  if (value === undefined) return "";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function isCommonOrder(orderBy?: OrderByParams): boolean {
  return Boolean(
    orderBy?.type === "system" &&
    ["title", "createdAt", "updatedAt"].includes(orderBy.key),
  );
}

function isCommonGroup(groupBy?: GroupByParams): boolean {
  return Boolean(
    groupBy?.type === "system" &&
    ["createdAt", "updatedAt"].includes(groupBy.key),
  );
}

/**
 * Compose the mixed Page surface after document rules have run. Database Pages
 * only participate in explicitly common Page criteria; every document-only
 * criterion excludes them rather than silently changing its meaning.
 */
export function composeWorkspacePageGroups({
  databaseFavorites,
  databases,
  documentGroups,
  documentMetadata,
  filters,
  groupBy,
  orderBy,
}: {
  databaseFavorites: ReadonlySet<string>;
  databases: readonly DatabasePageRecord[];
  documentGroups: readonly WorkspacePageGroup[];
  documentMetadata: ReadonlyMap<string, WorkspaceDocumentPageMetadata>;
  filters: readonly FilterParams[];
  groupBy?: GroupByParams;
  orderBy?: OrderByParams;
}): WorkspacePageGroup[] {
  const filteredDatabases = databases.filter((database) =>
    filters.every((filter) =>
      databaseMatchesFilter(
        database,
        filter,
        databaseFavorites.has(database.id),
      ),
    ),
  );

  const encodedDocuments = documentGroups.map((group) => ({
    key: group.key,
    items: group.items.map((id) => workspacePageKey({ kind: "document", id })),
  }));

  // A document-only order/group has already been resolved by CollectionRules.
  // Keeping only documents is the deterministic mixed-Page contract.
  if (
    (groupBy && !isCommonGroup(groupBy)) ||
    (orderBy && !isCommonOrder(orderBy))
  ) {
    return encodedDocuments;
  }

  const databaseByKey = new Map(
    filteredDatabases.map((database) => [database.key, database] as const),
  );
  const documentByKey = new Map(
    [...documentMetadata.values()].map((document) => [
      workspacePageKey({ kind: "document", id: document.id }),
      document,
    ]),
  );

  if (isCommonGroup(groupBy)) {
    const groups = new Map<string, string[]>(
      encodedDocuments.map((group) => [group.key, [...group.items]]),
    );
    for (const database of filteredDatabases) {
      const key = localDateKey(
        groupBy?.key === "createdAt" ? database.createdAt : database.updatedAt,
      );
      const items = groups.get(key) ?? [];
      items.push(database.key);
      groups.set(key, items);
    }
    const grouped = [...groups].map(([key, items]) => ({ key, items }));
    if (!isCommonOrder(orderBy)) return grouped;
    const orderedKeys = sortWorkspacePageKeys(
      grouped.flatMap((group) => group.items),
      orderBy,
      documentByKey,
      databaseByKey,
    );
    const rank = new Map(orderedKeys.map((key, index) => [key, index]));
    return grouped
      .map((group) => ({
        ...group,
        items: sortWorkspacePageKeys(
          group.items,
          orderBy,
          documentByKey,
          databaseByKey,
        ),
      }))
      .sort(
        (left, right) =>
          (rank.get(left.items[0] ?? "") ?? Number.MAX_SAFE_INTEGER) -
          (rank.get(right.items[0] ?? "") ?? Number.MAX_SAFE_INTEGER),
      );
  }

  const allKeys = [
    ...encodedDocuments.flatMap((group) => group.items),
    ...filteredDatabases.map((database) => database.key),
  ];
  return [
    {
      key: "",
      items: isCommonOrder(orderBy)
        ? sortWorkspacePageKeys(allKeys, orderBy, documentByKey, databaseByKey)
        : allKeys,
    },
  ];
}

function sortWorkspacePageKeys(
  keys: readonly string[],
  orderBy: OrderByParams | undefined,
  documents: ReadonlyMap<string, WorkspaceDocumentPageMetadata>,
  databases: ReadonlyMap<string, DatabasePageRecord>,
): string[] {
  if (!orderBy) return [...keys];
  const direction = orderBy.desc ? -1 : 1;
  const value = (key: string): string | number => {
    const identity = parseWorkspacePageKey(key);
    const page =
      identity?.kind === "database" ? databases.get(key) : documents.get(key);
    if (!page) return "";
    if (orderBy.key === "title") return page.title.toLocaleLowerCase();
    if (orderBy.key === "createdAt") {
      if (typeof page.createdAt === "number") return page.createdAt;
      return page.createdAt ? Date.parse(page.createdAt) : 0;
    }
    if (typeof page.updatedAt === "number") return page.updatedAt;
    return page.updatedAt ? Date.parse(page.updatedAt) : 0;
  };
  return [...keys].sort((left, right) => {
    const a = value(left);
    const b = value(right);
    if (a === b) return left.localeCompare(right);
    return (a > b ? 1 : -1) * direction;
  });
}
