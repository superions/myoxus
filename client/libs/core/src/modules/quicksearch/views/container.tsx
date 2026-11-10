import { UserFriendlyError } from "@myoxus/error";
import { useI18n } from "@myoxus/i18n";
import { useLiveData, useServices } from "@myoxus/infra";
import { useCallback, useEffect, useMemo } from "react";
import { useLocation } from "react-router";

import type { QuickSearchSourceState } from "../providers/quick-search-provider";
import { QuickSearchService } from "../services/quick-search";
import type { QuickSearchGroup } from "../types/group";
import type { QuickSearchItem } from "../types/item";
import { CMDK } from "./cmdk";
import { QuickSearchModal } from "./modal";

export const QuickSearchContainer = () => {
  const { quickSearchService } = useServices({
    QuickSearchService,
  });
  const quickSearch = quickSearchService.quickSearch;
  const open = useLiveData(quickSearch.show$);
  const query = useLiveData(quickSearch.query$);
  const loading = useLiveData(quickSearch.isLoading$);
  const items = useLiveData(quickSearch.items$);
  const sourceStates = useLiveData(quickSearch.sourceStates$);
  const error = useLiveData(quickSearch.error$);
  const options = useLiveData(quickSearch.options$);
  const i18n = useI18n();
  const location = useLocation();

  const onToggleQuickSearch = useCallback(
    (open: boolean) => {
      if (open) {
        // should never be here
      } else {
        quickSearch.hide();
      }
    },
    [quickSearch],
  );

  const groups = useMemo(() => {
    const groups: {
      group?: QuickSearchGroup;
      items: QuickSearchItem[];
      state?: QuickSearchSourceState;
    }[] = [];

    for (const item of items) {
      const group = item.group;
      const existingGroup = groups.find((g) => g.group?.id === group?.id);
      if (existingGroup) {
        existingGroup.items.push(item);
      } else {
        groups.push({ group, items: [item] });
      }
    }

    for (const state of sourceStates) {
      const existingGroup = groups.find(
        ({ group }) => group?.id === state.group.id,
      );
      if (existingGroup) {
        existingGroup.state = state;
      } else {
        groups.push({ group: state.group, items: [], state });
      }
    }

    for (const { items } of groups) {
      items.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    }

    groups.sort((a, b) => {
      const group = (b.group?.score ?? 0) - (a.group?.score ?? 0);
      if (group !== 0) {
        return group;
      }
      return (b.items[0]?.score ?? 0) - (a.items[0]?.score ?? 0);
    });

    return groups;
  }, [items, sourceStates]);

  useEffect(() => {
    // Quick Search is global chrome. It must not survive route transitions as
    // a blocking overlay because the opened result can unmount underneath it.
    quickSearch.hide();
  }, [location.pathname, location.search, quickSearch]);

  const handleChangeQuery = useCallback(
    (query: string) => {
      quickSearch.setQuery(query);
    },
    [quickSearch],
  );

  const handleSubmit = useCallback(
    (item: QuickSearchItem) => {
      quickSearch.submit(item);
    },
    [quickSearch],
  );

  return (
    <QuickSearchModal open={open} onOpenChange={onToggleQuickSearch}>
      <CMDK
        query={query}
        groups={groups}
        error={error ? UserFriendlyError.fromAny(error).message : null}
        loading={loading}
        onQueryChange={handleChangeQuery}
        onSubmit={handleSubmit}
        onOpenPage={options?.onOpenPage}
        inputLabel={options?.label && i18n.t(options.label)}
        placeholder={options?.placeholder && i18n.t(options.placeholder)}
      />
    </QuickSearchModal>
  );
};
