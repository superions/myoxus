import { createIdentifier } from "../primitives/di/index";
import type { ReferenceParams } from "../models/index";
import type { ExtensionType } from "../store/index";

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
