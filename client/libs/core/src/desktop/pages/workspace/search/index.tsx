// SPDX-License-Identifier: AGPL-3.0-or-later

import { useRegionalFormatters } from "@myoxus/core/components/hooks/myoxus/use-user-preferences";
import { getSearchResultsPath } from "@myoxus/core/desktop/route-paths";
import { toDocSearchParams } from "@myoxus/core/modules/navigation";
import {
  databaseRoute,
  databaseRowRoute,
} from "@myoxus/core/modules/quicksearch/impls/database-discovery";
import {
  ViewBody,
  ViewHeader,
  ViewIcon,
  ViewTitle,
  WorkbenchLink,
  WorkbenchService,
} from "@myoxus/core/modules/workbench";
import { useI18n } from "@myoxus/i18n";
import {
  DatabaseTableViewIcon,
  DocsIcon,
  SearchIcon,
} from "@myoxus/icons/react";
import { useService } from "@myoxus/infra";
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Group,
  Input,
  NavLink,
  PageContentRail,
  Select,
  Stack,
  Text,
  Title,
  WorkbenchHeaderFrame,
  WorkbenchHeaderTitle,
} from "@myoxus/ui-facade";
import { useEffect, useId, useState } from "react";
import { useSearchParams } from "react-router";

import { useSearchResults } from "./use-search-results";

function documentExcerpt(text: string | undefined, query: string) {
  // The existing search response may contain a complete plain-text document.
  // Bound presentation only; do not hydrate summaries or change source matching.
  const normalized = (text ?? "").replace(/\s+/gu, " ").trim();
  const match = normalized
    .toLocaleLowerCase()
    .indexOf(query.trim().toLocaleLowerCase());
  let start = Math.max(0, match - 80);
  const wordBoundary = normalized.indexOf(" ", start);
  if (start > 0 && wordBoundary >= 0 && wordBoundary < match)
    start = wordBoundary + 1;
  const excerpt = normalized.slice(start, start + 260);
  return `${start ? "…" : ""}${excerpt}${start + 260 < normalized.length ? "…" : ""}`;
}

type LoadedOrder = "source" | "asc" | "desc" | "updated-desc" | "updated-asc";

function sortLoaded<T extends { title?: string | null; updatedAt?: string }>(
  items: T[],
  order: LoadedOrder,
  locale: string,
  untitled: string,
) {
  // Sorting is a stable view of loaded hits; it never changes source paging.
  if (order === "source") return items;
  return [...items].sort((a, b) => {
    if (order === "updated-asc" || order === "updated-desc") {
      const aTime = Date.parse(a.updatedAt ?? "");
      const bTime = Date.parse(b.updatedAt ?? "");
      if (!Number.isFinite(aTime)) return Number.isFinite(bTime) ? 1 : 0;
      if (!Number.isFinite(bTime)) return -1;
      return (aTime - bTime) * (order === "updated-asc" ? 1 : -1);
    }
    return (
      (a.title || untitled).localeCompare(b.title || untitled, locale) *
      (order === "asc" ? 1 : -1)
    );
  });
}

export const Component = () => {
  const t = useI18n();
  const { formatDateTime } = useRegionalFormatters();
  const headingId = useId();
  const workbench = useService(WorkbenchService).workbench;
  const [params] = useSearchParams();
  const query = params.get("q") ?? "";
  const [input, setInput] = useState(query);
  const [showExcerpt, setShowExcerpt] = useState(true);
  const [showParent, setShowParent] = useState(true);
  const [order, setOrder] = useState<LoadedOrder>("source");
  useEffect(() => setInput(query), [query]);
  const sources = useSearchResults(query.trim());
  const title = t["com.myoxus.search.results.title"]();
  const documents = sortLoaded(
    sources.documents.items,
    order,
    t.language,
    t["Untitled"](),
  );
  const databases = sortLoaded(
    sources.databases.items,
    order,
    t.language,
    t["Untitled"](),
  );
  const rows = sortLoaded(
    sources.rows.items,
    order,
    t.language,
    t["Untitled"](),
  );
  const modificationDate = (value?: string) =>
    value && Number.isFinite(Date.parse(value)) ? (
      <Text component="time" dateTime={value} size="sm" c="dimmed">
        {t["com.myoxus.workspace-pages.meta.updated"]({
          date: formatDateTime(value),
        })}
      </Text>
    ) : undefined;
  const groups = [
    {
      id: "documents",
      title: t["Documents"](),
      state: sources.documents,
      content: documents.map((hit) => (
        <NavLink
          key={hit.docId}
          component={WorkbenchLink}
          to={`/${encodeURIComponent(hit.docId)}${hit.blockId ? `?${toDocSearchParams({ blockIds: [hit.blockId] })}` : ""}`}
          label={hit.title || t["Untitled"]()}
          aria-label={hit.title || t["Untitled"]()}
          description={
            showExcerpt
              ? documentExcerpt(hit.blockContent, query) || undefined
              : undefined
          }
          leftSection={<DocsIcon />}
          rightSection={modificationDate(hit.updatedAt)}
        />
      )),
    },
    {
      id: "databases",
      title: t["com.myoxus.database.index.title"](),
      state: sources.databases,
      content: databases.map((hit) => (
        <NavLink
          key={hit.id}
          component={WorkbenchLink}
          to={databaseRoute(hit.id)}
          label={hit.title || t["Untitled"]()}
          aria-label={hit.title || t["Untitled"]()}
          leftSection={<DatabaseTableViewIcon />}
          rightSection={modificationDate(hit.updatedAt)}
        />
      )),
    },
    {
      id: "rows",
      title: t["com.myoxus.database.rows.title"](),
      state: sources.rows,
      content: rows.map((hit) => (
        <NavLink
          key={`${hit.databaseId}:${hit.rowId}`}
          component={WorkbenchLink}
          to={databaseRowRoute(hit.databaseId, hit.rowId)}
          label={hit.title || t["Untitled"]()}
          aria-label={hit.title || t["Untitled"]()}
          description={showParent ? hit.parentTitle : undefined}
          leftSection={<DatabaseTableViewIcon />}
          rightSection={modificationDate(hit.updatedAt)}
        />
      )),
    },
  ];
  return (
    <>
      <ViewTitle title={title} />
      <ViewIcon icon="allDocs" />
      <ViewHeader>
        <WorkbenchHeaderFrame
          title={<WorkbenchHeaderTitle>{title}</WorkbenchHeaderTitle>}
        />
      </ViewHeader>
      <ViewBody>
        <PageContentRail width="content" scroll>
          <Stack>
            <Group
              component="form"
              onSubmit={(event) => {
                event.preventDefault();
                workbench.open(getSearchResultsPath(input), { at: "active" });
              }}
            >
              <Input
                aria-label={t["com.myoxus.common.search"]()}
                placeholder={t["com.myoxus.common.search"]()}
                value={input}
                onChange={setInput}
                preFix={<SearchIcon />}
                flex={1}
              />
              <Button type="submit" variant="primary">
                {t["com.myoxus.common.search"]()}
              </Button>
              <Select
                contentSized
                aria-label={t["com.myoxus.search.results.sort-loaded"]()}
                value={order}
                onChange={(value) => {
                  if (
                    value === "source" ||
                    value === "asc" ||
                    value === "desc" ||
                    value === "updated-desc" ||
                    value === "updated-asc"
                  )
                    setOrder(value);
                }}
                data={[
                  {
                    value: "source",
                    label: t["com.myoxus.search.results.source-order"](),
                  },
                  {
                    value: "updated-desc",
                    label:
                      t["com.myoxus.templates.library.sort.updated-desc"](),
                  },
                  {
                    value: "updated-asc",
                    label: t["com.myoxus.templates.library.sort.updated-asc"](),
                  },
                  {
                    value: "asc",
                    label: t["com.myoxus.database.index.sort.title-asc"](),
                  },
                  {
                    value: "desc",
                    label: t["com.myoxus.database.index.sort.title-desc"](),
                  },
                ]}
              />
              <Checkbox
                checked={showExcerpt}
                onChange={(_, checked) => setShowExcerpt(checked)}
                label={t["com.myoxus.common.summary"]()}
              />
              <Checkbox
                checked={showParent}
                onChange={(_, checked) => setShowParent(checked)}
                label={t["com.myoxus.search.results.parent-name"]()}
              />
            </Group>
            <Text size="sm" c="dimmed">
              {t["com.myoxus.search.results.sort-loaded-hint"]()}
            </Text>
            {!query.trim() ? (
              <Text>{t["com.myoxus.search.results.empty-query"]()}</Text>
            ) : (
              groups.map((group) => (
                <Stack
                  component="section"
                  key={group.id}
                  aria-labelledby={`${headingId}-${group.id}`}
                  data-testid={`search-${group.id}`}
                >
                  <Group>
                    <Title order={3} id={`${headingId}-${group.id}`}>
                      {group.title}
                    </Title>
                    <Text aria-live="polite">
                      {t["com.myoxus.search.results.loaded"]({
                        loaded: new Intl.NumberFormat(t.language).format(
                          group.state.items.length,
                        ),
                      })}
                    </Text>
                  </Group>
                  {group.state.loading && !group.state.items.length ? (
                    <Text role="status">{t["com.myoxus.loading"]()}</Text>
                  ) : null}
                  {!group.state.loading &&
                  !group.state.error &&
                  !group.state.items.length ? (
                    <Text>{t["com.myoxus.cmdk.no-results"]()}</Text>
                  ) : null}
                  {group.state.items.length > 0 ? (
                    <Box component="nav" aria-label={group.title}>
                      {group.content}
                    </Box>
                  ) : null}
                  {group.state.error ? (
                    <Alert title={t["com.myoxus.common.operation-failed"]()}>
                      <Button onClick={group.state.retry}>
                        {t["Retry"]()}
                      </Button>
                    </Alert>
                  ) : null}
                  {group.state.hasMore &&
                  group.state.items.length > 0 &&
                  !group.state.error ? (
                    <Group>
                      <Button
                        variant="secondary"
                        loading={group.state.loading}
                        onClick={group.state.loadMore}
                      >
                        {t[
                          "com.myoxus.history.confirm-restore-modal.load-more"
                        ]()}
                      </Button>
                    </Group>
                  ) : null}
                </Stack>
              ))
            )}
          </Stack>
        </PageContentRail>
      </ViewBody>
    </>
  );
};
