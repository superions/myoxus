import {
  DocumentGraphDirection,
  type DocumentGraphMetadataFilterInput,
} from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import { FilterIcon, NetworkIcon, RightSidebarIcon } from "@myoxus/icons/react";
import {
  Badge,
  Button,
  Group,
  Menu,
  MenuItem,
  MenuPanel,
  MultiSelect,
  Popover,
  PopoverContent,
  PopoverTarget,
  Select,
  Stack,
} from "@myoxus/ui-facade";
import { useMemo, useState } from "react";

import type { DocumentGraphSelection, DocumentGraphViewModel } from "../model";
import type { GraphFilterOptions } from "./filter-options";

export function DocumentGraphToolbar({
  direction,
  filterOptions,
  filterOptionsLoading,
  graph,
  metadataFilter,
  onDirectionChange,
  onMetadataFilterChange,
  onSelect,
  onShowDetails,
  selection,
}: {
  direction: DocumentGraphDirection;
  filterOptions: GraphFilterOptions;
  filterOptionsLoading: boolean;
  graph: DocumentGraphViewModel | null;
  metadataFilter: DocumentGraphMetadataFilterInput | undefined;
  selection: DocumentGraphSelection | null;
  onDirectionChange: (direction: DocumentGraphDirection) => void;
  onMetadataFilterChange: (
    filter: DocumentGraphMetadataFilterInput | undefined,
  ) => void;
  onSelect: (selection: DocumentGraphSelection | null) => void;
  onShowDetails: () => void;
}) {
  const t = useI18n();
  const [filtersOpened, setFiltersOpened] = useState(false);
  const selectedFilterCount =
    (metadataFilter?.statuses?.length ?? 0) +
    (metadataFilter?.documentTypes?.length ?? 0) +
    (metadataFilter?.classifications?.length ?? 0);
  const searchData = useMemo(
    () => [
      ...(graph?.nodes.map((node) => ({
        label: node.label,
        value: selectionValue({ kind: "document", id: node.key }),
      })) ?? []),
      ...(graph?.databases.map((database) => ({
        label: database.title,
        value: selectionValue({ kind: "database", id: database.id }),
      })) ?? []),
    ],
    [graph],
  );

  return (
    <Group
      justify="space-between"
      wrap="wrap"
      data-myoxus-ui-role="document-graph-toolbar"
    >
      <Select
        clearable
        searchable
        aria-label={t["com.myoxus.database.document_link.picker-placeholder"]()}
        placeholder={t[
          "com.myoxus.database.document_link.picker-placeholder"
        ]()}
        data={searchData}
        value={selection ? selectionValue(selection) : null}
        onChange={(value) => onSelect(value ? parseSelection(value) : null)}
      />
      <Group gap="xs" wrap="nowrap">
        {selection ? (
          <Button
            data-testid="document-graph-show-details"
            prefix={<RightSidebarIcon />}
            variant="secondary"
            onClick={onShowDetails}
          >
            {t["com.myoxus.documentGraph.title"]()}
          </Button>
        ) : null}
        <Menu
          items={
            <MenuPanel>
              {[
                DocumentGraphDirection.Both,
                DocumentGraphDirection.Incoming,
                DocumentGraphDirection.Outgoing,
              ].map((value) => (
                <MenuItem
                  key={value}
                  selected={direction === value}
                  onSelect={() => onDirectionChange(value)}
                >
                  {directionLabel(t, value)}
                </MenuItem>
              ))}
            </MenuPanel>
          }
        >
          <Button prefix={<NetworkIcon />} variant="secondary">
            {directionLabel(t, direction)}
          </Button>
        </Menu>
        <Popover
          opened={filtersOpened}
          onChange={setFiltersOpened}
          position="bottom-end"
        >
          <PopoverTarget>
            <Button
              prefix={<FilterIcon />}
              variant="secondary"
              onClick={() => setFiltersOpened((opened) => !opened)}
            >
              {t["com.myoxus.editCollection.filters"]()}
              {selectedFilterCount ? (
                <Badge tone="neutral">{selectedFilterCount}</Badge>
              ) : null}
            </Button>
          </PopoverTarget>
          <PopoverContent>
            <Stack>
              <MultiSelect
                clearable
                searchable
                disabled={filterOptionsLoading}
                data={filterOptions.statuses}
                label={t["com.myoxus.documentGraph.filter.status"]()}
                placeholder={t["com.myoxus.documentGraph.filter.any"]()}
                value={metadataFilter?.statuses ?? []}
                onChange={(statuses) =>
                  onMetadataFilterChange(
                    compactMetadataFilter({ ...metadataFilter, statuses }),
                  )
                }
              />
              <MultiSelect
                clearable
                searchable
                disabled={filterOptionsLoading}
                data={filterOptions.documentTypes}
                label={t["com.myoxus.documentGraph.filter.document-type"]()}
                placeholder={t["com.myoxus.documentGraph.filter.any"]()}
                value={metadataFilter?.documentTypes ?? []}
                onChange={(documentTypes) =>
                  onMetadataFilterChange(
                    compactMetadataFilter({
                      ...metadataFilter,
                      documentTypes,
                    }),
                  )
                }
              />
              <MultiSelect
                clearable
                searchable
                disabled={filterOptionsLoading}
                data={filterOptions.classifications}
                label={t["com.myoxus.documentGraph.filter.classification"]()}
                placeholder={t["com.myoxus.documentGraph.filter.any"]()}
                value={metadataFilter?.classifications ?? []}
                onChange={(classifications) =>
                  onMetadataFilterChange(
                    compactMetadataFilter({
                      ...metadataFilter,
                      classifications,
                    }),
                  )
                }
              />
            </Stack>
          </PopoverContent>
        </Popover>
      </Group>
    </Group>
  );
}

function compactMetadataFilter(
  filter: DocumentGraphMetadataFilterInput,
): DocumentGraphMetadataFilterInput | undefined {
  return (filter.statuses?.length ?? 0) +
    (filter.documentTypes?.length ?? 0) +
    (filter.classifications?.length ?? 0) >
    0
    ? filter
    : undefined;
}

function selectionValue(selection: DocumentGraphSelection) {
  return `${selection.kind}:${selection.id}`;
}

function parseSelection(value: string): DocumentGraphSelection {
  const separator = value.indexOf(":");
  return {
    kind: value.slice(0, separator) as DocumentGraphSelection["kind"],
    id: value.slice(separator + 1),
  };
}

function directionLabel(
  t: ReturnType<typeof useI18n>,
  value: DocumentGraphDirection,
) {
  switch (value) {
    case DocumentGraphDirection.Incoming:
      return t["com.myoxus.documentGraph.direction.incoming"]();
    case DocumentGraphDirection.Outgoing:
      return t["com.myoxus.documentGraph.direction.outgoing"]();
    case DocumentGraphDirection.Both:
    default:
      return t["com.myoxus.documentGraph.direction.both"]();
  }
}
