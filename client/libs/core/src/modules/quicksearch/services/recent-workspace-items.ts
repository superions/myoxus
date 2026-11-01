import { Service } from "@myoxus/infra";

import type { DocRecord, DocsService } from "../../doc";
import type { WorkspaceLocalState } from "../../workspace";

const RECENT_WORKSPACE_ITEMS_LIMIT = 12;
const RECENT_WORKSPACE_ITEMS_KEY = "recent-workspace-items";
const LEGACY_RECENT_PAGES_KEY = "recent-pages";

export type RecentWorkspaceItem =
  { id: string; type: "doc" } | { id: string; type: "database" };

function isRecentWorkspaceItem(value: unknown): value is RecentWorkspaceItem {
  if (!value || typeof value !== "object") {
    return false;
  }
  const item = value as Partial<RecentWorkspaceItem>;
  return (
    typeof item.id === "string" &&
    item.id.length > 0 &&
    (item.type === "doc" || item.type === "database")
  );
}

function isRecentWorkspaceItemList(
  value: unknown,
): value is RecentWorkspaceItem[] {
  return Array.isArray(value) && value.every(isRecentWorkspaceItem);
}

function isLegacyRecentPageList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((id) => typeof id === "string" && id.length > 0)
  );
}

function uniqueRecentItems(items: RecentWorkspaceItem[]) {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.type}:${item.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Owns the bounded, workspace-scoped device history used by quick discovery.
 *
 * This is navigation history, not an authorization source. Consumers must
 * resolve every stored identifier through the current authorized inventory
 * before exposing it.
 */
export class RecentWorkspaceItemsService extends Service {
  constructor(
    private readonly localState: WorkspaceLocalState,
    private readonly docsService: DocsService,
  ) {
    super();
  }

  addRecentDoc(docId: string) {
    this.addRecentItem({ id: docId, type: "doc" });
  }

  addRecentDatabase(databaseId: string) {
    this.addRecentItem({ id: databaseId, type: "database" });
  }

  getRecentDocs() {
    const docs = this.docsService.list.docs$.value;
    return this.getRecentItems()
      .filter((item) => item.type === "doc")
      .map((item) => item.id)
      .map((id) => docs.find((doc) => doc.id === id))
      .filter((d): d is DocRecord => !!d);
  }

  getRecentDatabaseIds() {
    return this.getRecentItems()
      .filter((item) => item.type === "database")
      .map((item) => item.id);
  }

  getRecentItems(): RecentWorkspaceItem[] {
    const current = this.localState.get<unknown>(RECENT_WORKSPACE_ITEMS_KEY);
    if (current !== undefined) {
      return isRecentWorkspaceItemList(current)
        ? uniqueRecentItems(current).slice(0, RECENT_WORKSPACE_ITEMS_LIMIT)
        : [];
    }

    const legacy = this.localState.get<unknown>(LEGACY_RECENT_PAGES_KEY);
    if (legacy === undefined) {
      return [];
    }
    if (!isLegacyRecentPageList(legacy)) {
      // Keep malformed legacy data untouched. A later repaired value can still
      // migrate instead of being hidden by an empty success marker.
      return [];
    }

    const migrated = uniqueRecentItems(
      legacy.map<RecentWorkspaceItem>((id) => ({ id, type: "doc" })),
    ).slice(0, RECENT_WORKSPACE_ITEMS_LIMIT);
    this.localState.set(RECENT_WORKSPACE_ITEMS_KEY, migrated);
    this.localState.del(LEGACY_RECENT_PAGES_KEY);
    return migrated;
  }

  private addRecentItem(item: RecentWorkspaceItem) {
    const current = this.getRecentItems().filter(
      (candidate) => candidate.id !== item.id || candidate.type !== item.type,
    );
    this.localState.set(
      RECENT_WORKSPACE_ITEMS_KEY,
      [item, ...current].slice(0, RECENT_WORKSPACE_ITEMS_LIMIT),
    );
  }
}
