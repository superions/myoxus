// SPDX-License-Identifier: AGPL-3.0-or-later
import { getArtworkUrl } from "@myoxus/theme/artwork";

import type { DatabaseSummaryFragment } from "@myoxus/graphql";
import { DatabaseProfileKind } from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import { DatabaseIcon, FavoritedIcon, FavoriteIcon } from "@myoxus/icons/react";
import {
  Badge,
  Button,
  EmptyState,
  ThemedImg,
  EmptyStateTitle,
  FormSelect,
  Group,
  IconButton,
  MyoxusText,
  PageContentRail,
  SearchInput,
  SimpleGrid,
  Stack,
  SurfaceListAction,
  SurfaceListCardHeader,
  SurfaceListItem,
  SurfaceListItemIcon,
  SurfaceListMeta,
  SurfaceListText,
} from "@myoxus/ui-facade";
import type { ReactNode } from "react";

export type DatabaseInventorySortValue =
  "updated-desc" | "title-asc" | "title-desc";

export function DatabaseInventory({
  canGoNext,
  emptyCta,
  favoriteIds,
  isPristine,
  onOpen,
  onPageChange,
  onSearchChange,
  onSortChange,
  onToggleFavorite,
  page,
  records,
  search,
  sort,
}: {
  canGoNext: boolean;
  emptyCta: ReactNode;
  favoriteIds: ReadonlySet<string>;
  isPristine: boolean;
  onOpen: (databaseId: string) => void;
  onPageChange: (page: number) => void;
  onSearchChange: (search: string) => void;
  onSortChange: (sort: DatabaseInventorySortValue) => void;
  onToggleFavorite: (databaseId: string) => void;
  page: number;
  records: readonly DatabaseSummaryFragment[];
  search: string;
  sort: DatabaseInventorySortValue;
}) {
  const t = useI18n();
  const dateFormatter = new Intl.DateTimeFormat(t.language, {
    dateStyle: "medium",
  });

  return (
    <PageContentRail
      fill
      scroll
      spacious
      width="wide"
      data-testid="database-index"
    >
      <Stack>
        <Group align="flex-end" wrap="wrap">
          <SearchInput
            label={t["com.myoxus.database.selector.search-placeholder"]()}
            placeholder={t["com.myoxus.database.selector.search-placeholder"]()}
            value={search}
            onChange={onSearchChange}
            data-testid="database-inventory-search"
          />
          <FormSelect
            label={t["com.myoxus.database.index.sort.label"]()}
            value={sort}
            onChange={(value) =>
              value && onSortChange(value as DatabaseInventorySortValue)
            }
            data={[
              {
                label: t["com.myoxus.database.index.sort.updated-desc"](),
                value: "updated-desc",
              },
              {
                label: t["com.myoxus.database.index.sort.title-asc"](),
                value: "title-asc",
              },
              {
                label: t["com.myoxus.database.index.sort.title-desc"](),
                value: "title-desc",
              },
            ]}
            data-testid="database-inventory-sort"
          />
        </Group>

        {records.length ? (
          <SimpleGrid
            cols={{ base: 1, md: 2, xl: 3 }}
            aria-label={t["com.myoxus.database.index.list-label"]()}
            data-testid="database-inventory-grid"
          >
            {records.map((database) => {
              const favorite = favoriteIds.has(database.id);
              return (
                <SurfaceListItem
                  key={database.id}
                  appearance="card"
                  density="card"
                  fullHeight
                  layout="column"
                  data-testid="database-list-row"
                >
                  <SurfaceListCardHeader>
                    <SurfaceListAction
                      onClick={() => onOpen(database.id)}
                      aria-label={database.title}
                      data-testid={`database-open-${database.id}`}
                    >
                      <SurfaceListItemIcon>
                        <DatabaseIcon />
                      </SurfaceListItemIcon>
                      <SurfaceListText
                        kind="card-title"
                        lineClamp={2}
                        truncate={false}
                      >
                        {database.title}
                      </SurfaceListText>
                    </SurfaceListAction>
                    <IconButton
                      icon={favorite ? <FavoritedIcon /> : <FavoriteIcon />}
                      tooltip={
                        favorite
                          ? t["com.myoxus.favoritePageOperation.remove"]()
                          : t["com.myoxus.favoritePageOperation.add"]()
                      }
                      aria-pressed={favorite}
                      onClick={() => onToggleFavorite(database.id)}
                      data-testid={`database-favorite-${database.id}`}
                    />
                  </SurfaceListCardHeader>
                  {database.description ? (
                    <SurfaceListText
                      kind="description"
                      lineClamp={2}
                      truncate={false}
                    >
                      {database.description}
                    </SurfaceListText>
                  ) : null}
                  <SurfaceListMeta layout="card">
                    <Badge tone="neutral">
                      {database.profileKind === DatabaseProfileKind.Project
                        ? t["com.myoxus.database.template.profile.project"]()
                        : t["com.myoxus.database.template.profile.database"]()}
                    </Badge>
                    <MyoxusText tone="secondary" typographySlot="body-small">
                      {t["com.myoxus.database.index.meta"]({
                        fields: String(database.fieldCount),
                        rows: String(database.rowCount),
                        views: String(database.viewCount),
                      })}
                    </MyoxusText>
                    <MyoxusText tone="secondary" typographySlot="body-small">
                      {t["com.myoxus.workspace-pages.meta.updated"]({
                        date: dateFormatter.format(
                          new Date(database.updatedAt),
                        ),
                      })}
                    </MyoxusText>
                  </SurfaceListMeta>
                </SurfaceListItem>
              );
            })}
          </SimpleGrid>
        ) : (
          <EmptyState
            media={
              <ThemedImg fluid alt="" lightSrc={getArtworkUrl("database")} />
            }
            title={
              <EmptyStateTitle icon={<DatabaseIcon />}>
                {isPristine
                  ? t["com.myoxus.database.index.empty-title"]()
                  : t["com.myoxus.database.selector.empty-title"]()}
              </EmptyStateTitle>
            }
            description={
              isPristine
                ? t["com.myoxus.database.index.empty-description"]()
                : t["com.myoxus.database.index.no-results-description"]()
            }
            cta={isPristine ? emptyCta : undefined}
            data-testid={
              isPristine
                ? "database-inventory-empty"
                : "database-inventory-no-results"
            }
          />
        )}

        {page > 0 || canGoNext ? (
          <Group justify="space-between" wrap="wrap">
            <Button
              variant="secondary"
              disabled={page === 0}
              onClick={() => onPageChange(Math.max(0, page - 1))}
            >
              {t["common.previous"]()}
            </Button>
            <SurfaceListMeta>
              {t["com.myoxus.database.index.page"]({
                page: String(page + 1),
              })}
            </SurfaceListMeta>
            <Button
              variant="secondary"
              disabled={!canGoNext}
              onClick={() => onPageChange(page + 1)}
            >
              {t["common.next"]()}
            </Button>
          </Group>
        ) : null}
      </Stack>
    </PageContentRail>
  );
}
