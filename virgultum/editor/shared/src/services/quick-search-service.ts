import { createIdentifier } from "@virgultum/global/di";
import type { ReferenceParams } from "@virgultum/model";
import type { ExtensionType } from "@virgultum/store";

export interface QuickSearchService {
  openQuickSearch: () => Promise<QuickSearchResult>;
}

export type QuickSearchResult =
  | {
      docId: string;
      params?: ReferenceParams;
    }
  | {
      externalUrl: string;
    }
  | null;

export const QuickSearchProvider = createIdentifier<QuickSearchService>(
  "MyoxusQuickSearchService",
);

export function QuickSearchExtension(
  quickSearchService: QuickSearchService,
): ExtensionType {
  return {
    setup: (di) => {
      di.addImpl(QuickSearchProvider, quickSearchService);
    },
  };
}
