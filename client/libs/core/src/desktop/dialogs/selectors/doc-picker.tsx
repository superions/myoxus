// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { Filters } from "@myoxus/core/components/filter";
import { AddFilterMenu } from "@myoxus/core/components/filter/add-filter";
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

import { SelectorFrame } from "./selector-frame";

const DocPickerRow = memo(function DocPickerRow({
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
  const DocIcon = useLiveData(displayMeta.icon$(docId));

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
        <DocIcon />
      </SurfaceListItemIcon>
      <SurfaceListItemMain grow>
        <SurfaceListText kind="title">
          {title || t["Untitled"]()}
        </SurfaceListText>
      </SurfaceListItemMain>
    </SurfaceListItem>
  );
});

export interface DocPickerProps {
  init?: string[];
  multiple?: boolean;
  /** Mandatory eligibility filters kept active alongside user-added filters. */
  extraFilters?: readonly FilterParams[];
  buttons?: ReactNode;
  onChange?: (selectedIds: string[]) => void;
  onConfirm?: (selectedIds: string[]) => void;
  onCancel?: () => void;
}

/**
 * Searchable, filterable workspace document picker shared by the document
 * selector modal and the collection editor's manual page-inclusion tab.
 */
export const DocPicker = memo(function DocPicker({
  init = [],
  multiple = true,
  extraFilters,
  buttons,
  onChange,
  onConfirm,
  onCancel,
}: DocPickerProps) {
  const t = useI18n();
  const collectionRulesService = useService(CollectionRulesService);
  const [searchText, setSearchText] = useState("");
  const [filters, setFilters] = useState<FilterParams[]>([]);
  const [docIds, setDocIds] = useState<string[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>(() =>
    multiple ? init : init.slice(0, 1),
  );

  useEffect(() => {
    setSelectedIds(multiple ? init : init.slice(0, 1));
  }, [init, multiple]);

  useEffect(() => {
    onChange?.(selectedIds);
  }, [onChange, selectedIds]);

  useEffect(() => {
    const activeFilters: FilterParams[] =
      filters.length > 0
        ? [...filters]
        : [{ type: "system", key: "trash", method: "is", value: "false" }];

    if (searchText) {
      activeFilters.push({
        type: "system",
        key: "title",
        method: "match",
        value: searchText,
      });
    }

    const subscription = collectionRulesService
      .watch({
        filters: activeFilters,
        extraFilters: [
          ...(extraFilters ?? []),
          {
            type: "system",
            key: "empty-journal",
            method: "is",
            value: "false",
          },
          { type: "system", key: "trash", method: "is", value: "false" },
        ],
        orderBy: { type: "system", key: "updatedAt", desc: true },
      })
      .subscribe((result) => {
        setDocIds(
          Array.from(new Set(result.groups.flatMap((group) => group.items))),
        );
      });

    return () => subscription.unsubscribe();
  }, [collectionRulesService, extraFilters, filters, searchText]);

  const toggleDoc = useCallback(
    (docId: string) => {
      setSelectedIds((prev) => {
        if (prev.includes(docId)) {
          return prev.filter((id) => id !== docId);
        }
        return multiple ? [...prev, docId] : [docId];
      });
    },
    [multiple],
  );

  return (
    <SelectorFrame
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
                onAdd={(next) => setFilters((prev) => [...prev, next])}
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

        {docIds.length > 0 ? (
          <SurfaceList label={t["com.myoxus.workspace-pages.kind.documents"]()}>
            {docIds.map((docId) => (
              <DocPickerRow
                key={docId}
                docId={docId}
                selected={selectedIds.includes(docId)}
                onToggle={() => toggleDoc(docId)}
              />
            ))}
          </SurfaceList>
        ) : (
          <EmptyState
            title={t["com.myoxus.selectPage.empty"]()}
            description={
              searchText ? (
                <Trans
                  i18nKey="com.myoxus.selectPage.empty.tips"
                  values={{ search: searchText }}
                >
                  No page titles contain
                  <MyoxusText
                    component="span"
                    tone="accent"
                    typographySlot="body"
                  >
                    search
                  </MyoxusText>
                </Trans>
              ) : undefined
            }
          />
        )}
      </Scrollable.Viewport>
    </SelectorFrame>
  );
});
