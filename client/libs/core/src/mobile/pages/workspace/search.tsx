import { CollectionService } from "@myoxus/core/modules/collection";
import {
  type QuickSearchItem,
  QuickSearchTagIcon,
} from "@myoxus/core/modules/quicksearch";
import { TagService } from "@myoxus/core/modules/tag";
import { UserFriendlyError } from "@myoxus/error";
import { useI18n } from "@myoxus/i18n";
import { ViewLayersIcon } from "@myoxus/icons/react";
import { LiveData, useLiveData, useService, useServices } from "@myoxus/infra";
import {
  MobileSearchCancelButton,
  MobileSearchHeader,
  startScopedViewTransition,
  useThemeColor,
} from "@myoxus/ui-facade";
import { sleep } from "@virgultum/editor/global/utils";
import { useCallback, useMemo } from "react";

import {
  NavigationBackButton,
  SearchInput,
  SearchResLabel,
  searchVTScope,
} from "../../components";
import { MobileSearchService } from "../../modules/search";
import { SearchResults } from "../../views/search/search-results";

const searchInput$ = new LiveData("");

const RecentList = () => {
  const { mobileSearchService, collectionService, tagService } = useServices({
    MobileSearchService,
    CollectionService,
    TagService,
  });
  const recentDocsList = useLiveData(mobileSearchService.recentDocs.items$);
  const collectionMetas = useLiveData(collectionService.collectionMetas$);
  const tags = useLiveData(
    LiveData.computed((get) =>
      get(tagService.tagList.tags$).map((tag) => ({
        id: tag.id,
        title: get(tag.value$),
        color: get(tag.color$),
      })),
    ),
  );

  const docs = useMemo(
    () =>
      recentDocsList.map((item) => ({
        id: item.payload.docId,
        icon: item.icon,
        title: <SearchResLabel item={item} />,
      })),
    [recentDocsList],
  );

  const collectionList = useMemo(() => {
    return collectionMetas.slice(0, 3).map((item) => {
      return {
        id: "collection:" + item.id,
        source: "collection",
        label: { title: item.name },
        icon: <ViewLayersIcon />,
        payload: { collectionId: item.id },
      } satisfies QuickSearchItem<"collection", { collectionId: string }>;
    });
  }, [collectionMetas]);

  const tagList = useMemo(() => {
    return tags
      .reverse()
      .slice(0, 3)
      .map((item) => {
        return {
          id: "tag:" + item.id,
          source: "tag",
          label: { title: item.title },
          icon: <QuickSearchTagIcon color={item.color} />,
          payload: { tagId: item.id },
        } satisfies QuickSearchItem<"tag", { tagId: string }>;
      });
  }, [tags]);

  return (
    <SearchResults
      title="Recent"
      docs={docs}
      collections={collectionList}
      tags={tagList}
    />
  );
};

const WithQueryList = () => {
  const searchService = useService(MobileSearchService);
  const collectionList = useLiveData(searchService.collections.items$);
  const docList = useLiveData(searchService.docs.items$);
  const tagList = useLiveData(searchService.tags.items$);

  const error = useLiveData(searchService.docs.error$);

  const docs = useMemo(
    () =>
      docList
        .filter((item) => item.id !== "search-locally")
        .map((item) => ({
          id: item.payload.docId,
          icon: item.icon,
          title: <SearchResLabel item={item} />,
        })),
    [docList],
  );

  return (
    <SearchResults
      title="Search result"
      docs={docs}
      collections={collectionList}
      tags={tagList}
      error={error ? UserFriendlyError.fromAny(error).message : null}
    />
  );
};

export const Component = () => {
  const t = useI18n();
  useThemeColor("backgroundSecondaryColor");
  const searchInput = useLiveData(searchInput$);
  const searchService = useService(MobileSearchService);

  const onSearch = useCallback(
    (v: string) => {
      searchInput$.next(v);
      searchService.recentDocs.query(v);
      searchService.collections.query(v);
      searchService.docs.query(v);
      searchService.tags.query(v);
    },
    [
      searchService.collections,
      searchService.docs,
      searchService.recentDocs,
      searchService.tags,
    ],
  );

  const transitionBack = useCallback(() => {
    startScopedViewTransition(searchVTScope, async () => {
      history.back();
      await sleep(10);
    });
  }, []);

  return (
    <>
      <MobileSearchHeader data-testid="search-header">
        <SearchInput
          debounce={300}
          autoFocus={!searchInput}
          value={searchInput}
          onInput={onSearch}
          placeholder="Search Docs, Collections"
        />
        <NavigationBackButton>
          <MobileSearchCancelButton onClick={transitionBack}>
            {t["Cancel"]()}
          </MobileSearchCancelButton>
        </NavigationBackButton>
      </MobileSearchHeader>
      {searchInput ? <WithQueryList /> : <RecentList />}
    </>
  );
};
