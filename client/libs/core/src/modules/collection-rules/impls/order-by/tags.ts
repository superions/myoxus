import type { DocsService } from "@myoxus/core/modules/doc";
import type { TagService } from "@myoxus/core/modules/tag";
import { Service } from "@myoxus/infra";
import { combineLatest, map, type Observable } from "rxjs";

import type { OrderByProvider } from "../../provider";
import type { OrderByParams } from "../../types";

export class TagsOrderByProvider extends Service implements OrderByProvider {
  constructor(
    private readonly docsService: DocsService,
    private readonly tagService: TagService,
  ) {
    super();
  }

  orderBy$(
    items$: Observable<Set<string>>,
    params: OrderByParams,
  ): Observable<string[]> {
    const isDesc = params.desc;
    return combineLatest([
      items$,
      this.tagService.tagList.tags$.map(
        (tags) => new Set(tags.map((t) => t.id)),
      ),
      this.docsService.allDocsTagIds$(),
    ]).pipe(
      map(([items, existsTags, docs]) =>
        docs
          .filter((doc) => doc.confirmed && items.has(doc.id))
          .map((doc) => {
            const filteredTags = doc.tags
              .filter((tag) => existsTags.has(tag)) // filter out tags that don't exist
              .sort() // sort tags by ids
              .join(","); // convert to string
            return [doc.id, filteredTags];
          })
          .sort(
            (a, b) =>
              (a[1] === b[1] ? 0 : a[1] > b[1] ? 1 : -1) * (isDesc ? -1 : 1),
          )
          .map((i) => i[0]),
      ),
    );
  }
}
