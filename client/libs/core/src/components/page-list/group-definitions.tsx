import { CompatibleFavoriteItemsAdapter } from "@myoxus/core/modules/favorite";
import { type Tag, TagService } from "@myoxus/core/modules/tag";
import { useI18n } from "@myoxus/i18n";
import { FavoritedIcon, FavoriteIcon } from "@myoxus/icons/react";
import { LiveData, useLiveData, useService } from "@myoxus/infra";
import {
  ColorSwatch,
  Group,
  MyoxusText,
  SurfaceListItemIcon,
} from "@myoxus/ui-facade";
import type { DocMeta } from "@virgultum/editor/store";
import { type ReactNode, useMemo } from "react";

import type { DateKey, ItemGroupDefinition, ListItem } from "./types";
import { useAllDocDisplayProperties } from "./use-all-doc-display-properties";
import { betweenDaysAgo, withinDaysAgo } from "./utils";

const GroupLabel = ({
  label,
  count,
  icon,
  id,
}: {
  id: string;
  label: ReactNode;
  count: number;
  icon?: ReactNode;
}) => (
  <Group
    gap="sm"
    justify="flex-start"
    data-myoxus-ui-role="surface-list-group-label"
  >
    {icon}
    <MyoxusText
      component="span"
      data-testid={`group-label-${id}`}
      tone="primary"
      typographySlot="nav"
    >
      {label}
    </MyoxusText>
    <MyoxusText component="span" tone="secondary" typographySlot="nav">
      {`· ${count}`}
    </MyoxusText>
  </Group>
);

// TODO(@JimmFly): optimize date matchers
export const useDateGroupDefinitions = <T extends ListItem>(
  key: DateKey,
): ItemGroupDefinition<T>[] => {
  const t = useI18n();
  return useMemo(
    () => [
      {
        id: "today",
        label: (count) => (
          <GroupLabel
            id="today"
            label={t["com.myoxus.today"]()}
            count={count}
          />
        ),
        match: (item) =>
          withinDaysAgo(new Date(item[key] ?? item.createDate ?? ""), 1),
      },
      {
        id: "yesterday",
        label: (count) => (
          <GroupLabel
            id="yesterday"
            label={t["com.myoxus.yesterday"]()}
            count={count}
          />
        ),
        match: (item) =>
          betweenDaysAgo(new Date(item[key] ?? item.createDate ?? ""), 1, 2),
      },
      {
        id: "last7Days",
        label: (count) => (
          <GroupLabel
            id="last7Days"
            label={t["com.myoxus.last7Days"]()}
            count={count}
          />
        ),
        match: (item) =>
          betweenDaysAgo(new Date(item[key] ?? item.createDate ?? ""), 2, 7),
      },
      {
        id: "last30Days",
        label: (count) => (
          <GroupLabel
            id="last30Days"
            label={t["com.myoxus.last30Days"]()}
            count={count}
          />
        ),
        match: (item) =>
          betweenDaysAgo(new Date(item[key] ?? item.createDate ?? ""), 7, 30),
      },
      {
        id: "moreThan30Days",
        label: (count) => (
          <GroupLabel
            id="moreThan30Days"
            label={t["com.myoxus.moreThan30Days"]()}
            count={count}
          />
        ),
        match: (item) =>
          !withinDaysAgo(new Date(item[key] ?? item.createDate ?? ""), 30),
      },
    ],
    [key, t],
  );
};

const GroupTagLabel = ({ tag, count }: { tag: Tag; count: number }) => {
  const tagValue = useLiveData(tag.value$);
  const tagColor = useLiveData(tag.color$);
  return (
    <GroupLabel
      id={tag.id}
      label={tagValue}
      count={count}
      icon={
        <ColorSwatch aria-label={tagValue} color={tagColor} shape="circle" />
      }
    ></GroupLabel>
  );
};
export const useTagGroupDefinitions = (): ItemGroupDefinition<ListItem>[] => {
  const tagList = useService(TagService).tagList;
  const sortedTagsLiveData$ = useMemo(
    () =>
      LiveData.computed((get) =>
        get(tagList.tags$)
          .slice()
          .sort((a, b) => get(a.value$).localeCompare(get(b.value$))),
      ),
    [tagList.tags$],
  );
  const tags = useLiveData(sortedTagsLiveData$);

  const t = useI18n();

  const untagged = useMemo(
    () => ({
      id: "Untagged",
      label: (count: number) => (
        <GroupLabel
          id="Untagged"
          label={t["com.myoxus.page.display.grouping.group-by-tag.untagged"]()}
          count={count}
        />
      ),
      match: (item: ListItem) =>
        (item as DocMeta).tags ? !(item as DocMeta).tags.length : false,
    }),
    [t],
  );

  return useMemo(() => {
    return tags
      .map((tag) => ({
        id: tag.id,
        label: (count: number) => {
          return <GroupTagLabel tag={tag} count={count} />;
        },
        match: (item: ListItem) => (item as DocMeta).tags?.includes(tag.id),
      }))
      .concat(untagged);
  }, [tags, untagged]);
};

export const useFavoriteGroupDefinitions = <
  T extends ListItem,
>(): ItemGroupDefinition<T>[] => {
  const t = useI18n();
  const favAdapter = useService(CompatibleFavoriteItemsAdapter);
  const favourites = useLiveData(favAdapter.favorites$);
  return useMemo(
    () => [
      {
        id: "favourited",
        label: (count) => (
          <GroupLabel
            id="favourited"
            label={t["com.myoxus.page.group-header.favourited"]()}
            count={count}
            icon={
              <SurfaceListItemIcon size="sm">
                <FavoritedIcon aria-hidden="true" />
              </SurfaceListItemIcon>
            }
          />
        ),
        match: (item) => favourites.some((fav) => fav.id === item.id),
      },
      {
        id: "notFavourited",
        label: (count) => (
          <GroupLabel
            id="notFavourited"
            label={t["com.myoxus.page.group-header.not-favourited"]()}
            count={count}
            icon={
              <SurfaceListItemIcon size="sm">
                <FavoriteIcon aria-hidden="true" />
              </SurfaceListItemIcon>
            }
          />
        ),
        match: (item) => !favourites.some((fav) => fav.id === item.id),
      },
    ],
    [t, favourites],
  );
};

export const usePageItemGroupDefinitions = () => {
  const [workspaceProperties] = useAllDocDisplayProperties();
  const tagGroupDefinitions = useTagGroupDefinitions();
  const createDateGroupDefinitions = useDateGroupDefinitions("createDate");
  const updatedDateGroupDefinitions = useDateGroupDefinitions("updatedDate");
  const favouriteGroupDefinitions = useFavoriteGroupDefinitions();

  return useMemo(() => {
    const itemGroupDefinitions = {
      createDate: createDateGroupDefinitions,
      updatedDate: updatedDateGroupDefinitions,
      tag: tagGroupDefinitions,
      favourites: favouriteGroupDefinitions,
      none: undefined,

      // add more here later
      // todo(@JimmFly): some page group definitions maybe dynamic
    };
    return itemGroupDefinitions[workspaceProperties.groupBy];
  }, [
    createDateGroupDefinitions,
    favouriteGroupDefinitions,
    tagGroupDefinitions,
    updatedDateGroupDefinitions,
    workspaceProperties.groupBy,
  ]);
};
