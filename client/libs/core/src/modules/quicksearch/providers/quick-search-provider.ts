import { type LiveData } from "@myoxus/infra";

import type { QuickSearchGroup } from "../types/group";
import type { QuickSearchItem } from "../types/item";

export type QuickSearchSourceState = {
  error: unknown;
  group: QuickSearchGroup;
  loading: boolean;
  retry?: () => void;
};

export type QuickSearchFunction<S, P> = (
  query: string,
) => QuickSearchItem<S, P>[];

export interface QuickSearchSession<S, P> {
  items$: LiveData<QuickSearchItem<S, P>[]>;
  error$?: LiveData<any>;
  group?: QuickSearchGroup;
  isLoading$?: LiveData<boolean>;
  loadingProgress$?: LiveData<number>;
  hasMore$?: LiveData<boolean>;

  query?: (query: string) => void;
  loadMore?: () => void;
  retry?: () => void;
  dispose?: () => void;
  beforeSubmit?: (item: QuickSearchItem<S, P>) => boolean;
}

export type QuickSearchSource<S, P> =
  QuickSearchFunction<S, P> | QuickSearchSession<S, P>;

export type QuickSearchSourceItemType<Source> =
  Source extends QuickSearchSource<infer S, infer P>
    ? QuickSearchItem<S, P>
    : never;
