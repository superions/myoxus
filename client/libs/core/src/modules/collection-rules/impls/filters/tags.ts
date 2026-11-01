import type { DocsService } from "@myoxus/core/modules/doc";
import type { TagService } from "@myoxus/core/modules/tag";
import type { WorkspacePropertyFilter } from "@myoxus/core/modules/workspace-property";
import { Service } from "@myoxus/infra";
import { combineLatest, map, type Observable } from "rxjs";

import type { FilterProvider } from "../../provider";
import type { FilterParams } from "../../types";

export class TagsFilterProvider extends Service implements FilterProvider {
  constructor(
    private readonly tagService: TagService,
    private readonly docsService: DocsService,
  ) {
    super();
  }

  filter$(params: FilterParams): Observable<Set<string>> {
    const method = params.method as WorkspacePropertyFilter<"tags">;
    const tagIds = params.value?.split(",").filter(Boolean) ?? [];
    return combineLatest([
      this.tagService.tagList.tags$.map(
        (tags) => new Set(tags.map((tag) => tag.id)),
      ),
      this.docsService.allDocsTagIds$(),
    ]).pipe(
      map(
        ([catalog, docs]) =>
          new Set(
            docs
              .filter((doc) => {
                // Unknown reads must never satisfy an empty or negative filter. Stale
                // confirmed assignments retain their last result while retry is visible.
                if (!doc.confirmed) return false;
                const assigned = new Set(
                  doc.tags.filter((id) => catalog.has(id)),
                );
                switch (method) {
                  case "include-all":
                    return (
                      tagIds.length > 0 &&
                      tagIds.every((id) => assigned.has(id))
                    );
                  case "not-include-all":
                    return (
                      tagIds.length > 0 &&
                      !tagIds.every((id) => assigned.has(id))
                    );
                  case "include-any-of":
                    return tagIds.some((id) => assigned.has(id));
                  case "not-include-any-of":
                    return (
                      tagIds.length > 0 &&
                      !tagIds.some((id) => assigned.has(id))
                    );
                  case "is-not-empty":
                    return assigned.size > 0;
                  case "is-empty":
                    return assigned.size === 0;
                  default:
                    throw new Error(`Unsupported method: ${method}`);
                }
              })
              .map((doc) => doc.id),
          ),
      ),
    );
  }
}
