// SPDX-License-Identifier: MIT

import {
  CollectionRulesService,
  type FilterParams,
} from "@myoxus/core/modules/collection-rules";
import { DocDisplayMetaService } from "@myoxus/core/modules/doc-display-meta";
import { Trans, useI18n } from "@myoxus/i18n";
import { FilterIcon } from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";
import {
  Checkbox,
  EmptyState,
  IconButton,
  Menu,
  MyoxusText,
  Scrollable,
  SurfaceList,
  SurfaceListItem,
  SurfaceListItemIcon,
  SurfaceListItemMain,
  SurfaceListText,
} from "@myoxus/ui-facade";
import { memo, type ReactNode, useCallback, useEffect, useState } from "react";

import { Filters } from "../../filter";
import { AddFilterMenu } from "../../filter/add-filter";
import { SelectorLayout } from "../selector/selector-layout";

const SelectPageRow = memo(function SelectPageRow({
  docId,
  selected,
  onToggle,
}: {
  docId: string;
  selected: boolean;
  onToggle: () => void;
}) {
  const t = useI18n();
  const displayMeta = useService(DocDisplayMetaService);
  const title = useLiveData(displayMeta.title$(docId));
  const Icon = useLiveData(displayMeta.icon$(docId));
  return (
    <SurfaceListItem
      component="label"
      interactive
      layout="row"
      density="compact"
      selected={selected}
      data-testid={`select-page-row-${docId}`}
    >
      <Checkbox
        aria-label={t["com.myoxus.all-docs.quick-action.select"]()}
        checked={selected}
        onChange={onToggle}
        size="xs"
      />
      <SurfaceListItemIcon size="md">
        <Icon />
      </SurfaceListItemIcon>
      <SurfaceListItemMain grow>
        <SurfaceListText kind="title">
          {title || t["Untitled"]()}
        </SurfaceListText>
      </SurfaceListItemMain>
    </SurfaceListItem>
  );
});

/** Compact document picker. Page-explorer display, drag and bulk-delete
 * behavior intentionally stay outside this modal/inline selection role. */
export const SelectPage = memo(function SelectPage({
  init = [],
  onConfirm,
  onCancel,
  onChange,
  buttons,
  multiple = true,
  extraFilters,
}: {
  onChange?: (values: string[]) => void;
  confirmText?: ReactNode;
  buttons?: ReactNode;
  init?: string[];
  multiple?: boolean;
  /** Required eligibility filters stay active while the user adds filters. */
  extraFilters?: readonly FilterParams[];
  onConfirm?: (data: string[]) => void;
  onCancel?: () => void;
}) {
  const t = useI18n();
  const collectionRulesService = useService(CollectionRulesService);
  const [searchText, setSearchText] = useState("");
  const [filters, setFilters] = useState<FilterParams[]>([]);
  const [documentIds, setDocumentIds] = useState<string[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>(init);

  useEffect(
    () => setSelectedIds(multiple ? init : init.slice(0, 1)),
    [init, multiple],
  );
  useEffect(() => onChange?.(selectedIds), [onChange, selectedIds]);

  useEffect(() => {
    const searchFilter: FilterParams | null = searchText
      ? {
          type: "system",
          key: "title",
          method: "match",
          value: searchText,
        }
      : null;
    const watchFilters: FilterParams[] =
      filters.length > 0
        ? [...filters]
        : [
            {
              type: "system",
              key: "trash",
              method: "is",
              value: "false",
            },
          ];
    if (searchFilter) watchFilters.push(searchFilter);
    const subscription = collectionRulesService
      .watch({
        filters: watchFilters,
        extraFilters: [
          ...(extraFilters ?? []),
          {
            type: "system",
            key: "empty-journal",
            method: "is",
            value: "false",
          },
          {
            type: "system",
            key: "trash",
            method: "is",
            value: "false",
          },
        ],
        orderBy: {
          type: "system",
          key: "updatedAt",
          desc: true,
        },
      })
      .subscribe((result) => {
        setDocumentIds([
          ...new Set(result.groups.flatMap((group) => group.items)),
        ]);
      });
    return () => subscription.unsubscribe();
  }, [collectionRulesService, filters, searchText, extraFilters]);

  const toggle = useCallback(
    (docId: string) => {
      setSelectedIds((previous) =>
        previous.includes(docId)
          ? previous.filter((id) => id !== docId)
          : multiple
            ? [...previous, docId]
            : [docId],
      );
    },
    [multiple],
  );

  return (
    <SelectorLayout
      fitContent
      searchPlaceholder={t["com.myoxus.editCollection.search.placeholder"]()}
      selectedCount={selectedIds.length}
      onSearch={setSearchText}
      onClear={() => setSelectedIds([])}
      onCancel={onCancel}
      onConfirm={() => onConfirm?.(selectedIds)}
      actions={buttons}
      headerActions={
        filters.length === 0 ? (
          <Menu
            items={
              <AddFilterMenu
                onAdd={(params) => setFilters([...filters, params])}
              />
            }
          >
            <IconButton
              aria-label={t["com.myoxus.filter.add-filter"]()}
              icon={<FilterIcon />}
            />
          </Menu>
        ) : null
      }
    >
      <Scrollable.Viewport autosize maxHeight="selector">
        {filters.length > 0 ? (
          <Filters filters={filters} onChange={setFilters} />
        ) : null}
        {documentIds.length > 0 ? (
          <SurfaceList label={t["com.myoxus.workspace-pages.kind.documents"]()}>
            {documentIds.map((docId) => (
              <SelectPageRow
                key={docId}
                docId={docId}
                selected={selectedIds.includes(docId)}
                onToggle={() => toggle(docId)}
              />
            ))}
          </SurfaceList>
        ) : (
          <EmptyList search={searchText} />
        )}
      </Scrollable.Viewport>
    </SelectorLayout>
  );
});

export const EmptyList = ({ search }: { search?: string }) => {
  const t = useI18n();
  return (
    <EmptyState
      description={
        search ? (
          <Trans i18nKey="com.myoxus.selectPage.empty.tips" values={{ search }}>
            No page titles contain
            <MyoxusText component="span" tone="accent" typographySlot="body">
              search
            </MyoxusText>
          </Trans>
        ) : undefined
      }
      title={t["com.myoxus.selectPage.empty"]()}
    />
  );
};
