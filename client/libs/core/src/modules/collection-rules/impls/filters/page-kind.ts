import type { DocsService } from "@myoxus/core/modules/doc";
import { Service } from "@myoxus/infra";
import { map, type Observable } from "rxjs";

import type { FilterProvider } from "../../provider";
import type { FilterParams } from "../../types";

/** Document-side half of the mixed Page-kind filter. */
export class PageKindFilterProvider extends Service implements FilterProvider {
  constructor(private readonly docsService: DocsService) {
    super();
  }

  filter$(params: FilterParams): Observable<Set<string>> {
    if (params.method !== "is") {
      throw new Error(`Unsupported method: ${params.method}`);
    }
    if (params.value === "database") {
      return this.docsService.allDocIds$().pipe(map(() => new Set<string>()));
    }
    if (params.value === "all" || params.value === "document") {
      return this.docsService.allDocIds$().pipe(map((ids) => new Set(ids)));
    }
    throw new Error(`Unsupported value: ${params.value}`);
  }
}
