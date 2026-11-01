import { LiveData, Service } from "@myoxus/infra";

import type { GlobalCache } from "../../storage/providers/global";
import type { WorkspaceService } from "../../workspace";

const DEFAULT_COLLAPSABLE_STATE: Record<string, boolean> = {
  recent: true,
  favorites: false,
  organize: false,
  collections: true,
  tags: true,
  favoritesOld: true,
  migrationFavorites: true,
  others: false,
};

export class StructureTreeStateService extends Service {
  constructor(
    private readonly globalCache: GlobalCache,
    private readonly workspaceService: WorkspaceService,
  ) {
    super();
  }

  private readonly collapsedCache = new Map<string, LiveData<boolean>>();

  private cacheKey(pathKey: string) {
    // Keep structure-tree UI state in its own persisted namespace.
    // Tracking event names still use their existing schema separately.
    return `structure-tree:${this.workspaceService.workspace.id}:${pathKey}`;
  }

  collapsed$(path: string[]) {
    const pathKey = path.join(":");
    const key = this.cacheKey(pathKey);
    const cached$ = this.collapsedCache.get(key);
    if (!cached$) {
      const liveData$ = LiveData.from(
        this.globalCache.watch<boolean>(key),
        undefined,
      ).map((v) => v ?? DEFAULT_COLLAPSABLE_STATE[pathKey] ?? true);
      this.collapsedCache.set(key, liveData$);
      return liveData$;
    }
    return cached$;
  }

  setCollapsed(path: string[], collapsed: boolean) {
    const pathKey = path.join(":");
    const key = this.cacheKey(pathKey);
    this.globalCache.set(key, collapsed);
  }
}
