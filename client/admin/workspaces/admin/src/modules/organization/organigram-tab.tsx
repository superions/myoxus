// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Organization organigram.
 *
 * The hierarchy uses Facade list primitives rather than a graph editor:
 * admins need readable, keyboard-selectable nodes and the existing audited
 * UnitDetail inspector, not a second editing surface.
 */
import type {
  AdminOrganizationUnitsQuery,
  AdminOrganizationUnitTypesQuery,
} from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import { Network, Search } from "@myoxus/icons/react";
import {
  Divider,
  Group,
  Input,
  SelectableCardRow,
  SettingsEmptyState,
  SettingsCollectionToolbar,
  SettingsMasterDetailLayout,
  Stack,
  StatusDot,
  StructureTreeContent,
  StructureTreeRoot,
  SurfaceList,
  SurfaceListItemIcon,
  SurfaceListItemMain,
  SurfaceListText,
} from "@myoxus/ui-facade";
import { useMemo, useState } from "react";

import {
  useOrganizationQuery,
  useOrganizationUnitsQuery,
  useOrganizationUnitTypesQuery,
} from "./api";
import { UnitDetail } from "./unit-detail";
import { AdminConfirmModal } from "../../components/shared/admin-confirm-modal";
import { getUnitTypeCatalogSelection } from "./unit-type-catalog";

type Unit = AdminOrganizationUnitsQuery["admin"]["organizationUnits"][number];
type UnitType =
  AdminOrganizationUnitTypesQuery["admin"]["organizationUnitTypes"][number];

const ROOT_PARENT = "__root__";

const STATUS_TONE: Record<
  string,
  "neutral" | "success" | "warning" | "error" | "info"
> = {
  ACTIVE: "success",
  DISABLED: "error",
  ARCHIVED: "neutral",
};

function childCount(unit: Unit) {
  return unit.childUnitCount ?? 0;
}

function memberCount(unit: Unit) {
  return unit.memberCount ?? 0;
}

function workspaceCount(unit: Unit) {
  return unit.workspaceCount ?? 0;
}

function unitMatchesQuery(
  unit: Unit,
  type: UnitType | undefined,
  query: string,
) {
  if (!query) return true;
  const needle = query.toLowerCase();
  return (
    unit.name.toLowerCase().includes(needle) ||
    unit.slug.toLowerCase().includes(needle) ||
    type?.label.toLowerCase().includes(needle) ||
    type?.key.toLowerCase().includes(needle)
  );
}

export function OrganigramTab() {
  const i18n = useI18n();
  const { organization } = useOrganizationQuery();
  const { units, mutate } = useOrganizationUnitsQuery();
  const { types } = useOrganizationUnitTypesQuery();
  const [selectedUnitId, setSelectedUnitId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [detailDirty, setDetailDirty] = useState(false);
  const [detailBusy, setDetailBusy] = useState(false);
  const [pendingUnitId, setPendingUnitId] = useState<string | null>(null);

  const catalogSelection = useMemo(
    () => getUnitTypeCatalogSelection(organization?.metadata),
    [organization?.metadata],
  );
  const typeById = useMemo(
    () => new Map(types.map((type) => [type.id, type])),
    [types],
  );
  const unitsByParent = useMemo(() => {
    const map = new Map<string, Unit[]>();
    for (const unit of units) {
      const key = unit.parentUnitId ?? ROOT_PARENT;
      const bucket = map.get(key) ?? [];
      bucket.push(unit);
      map.set(key, bucket);
    }
    for (const bucket of map.values()) {
      bucket.sort((a, b) => a.name.localeCompare(b.name));
    }
    return map;
  }, [units]);
  const selectedUnit =
    units.find((unit) => unit.id === selectedUnitId) ?? units[0] ?? null;
  const selectUnit = (id: string) => {
    if (detailBusy || id === selectedUnit?.id) return;
    if (detailDirty) setPendingUnitId(id);
    else setSelectedUnitId(id);
  };
  const rootUnits = unitsByParent.get(ROOT_PARENT) ?? [];
  const visibleIds = useMemo(() => {
    if (!query.trim()) return null;
    return new Set(
      units
        .filter((unit) =>
          unitMatchesQuery(unit, typeById.get(unit.unitTypeId), query),
        )
        .map((unit) => unit.id),
    );
  }, [query, typeById, units]);
  const renderNode = (unit: Unit, depth: number, seen: Set<string>) => {
    if (seen.has(unit.id)) return null;
    const nextSeen = new Set(seen).add(unit.id);
    const children = unitsByParent.get(unit.id) ?? [];
    const type = typeById.get(unit.unitTypeId);
    const highlighted = visibleIds ? visibleIds.has(unit.id) : true;
    const selected = selectedUnit?.id === unit.id;

    return (
      <StructureTreeContent
        role="listitem"
        key={unit.id}
        level={depth}
        open={children.length > 0}
      >
        <SelectableCardRow
          data-testid={`organization-organigram-node-${unit.id}`}
          data-selected={selected ? "true" : "false"}
          data-highlighted={highlighted ? "true" : "false"}
          onClick={() => selectUnit(unit.id)}
          selected={selected}
          density="compact"
        >
          <Group align="flex-start" justify="space-between" wrap="nowrap">
            <SurfaceListItemIcon size="md">
              <Network aria-hidden="true" />
            </SurfaceListItemIcon>
            <SurfaceListItemMain grow>
              <SurfaceListText kind="title">{unit.name}</SurfaceListText>
              <SurfaceListText kind="description">
                {type?.label ??
                  i18n.t("admin.organization.organigram.type-missing")}
                {" · "}
                {unit.slug}
              </SurfaceListText>
              <SurfaceListText kind="description">
                {i18n.t("admin.organization.organigram.node-counts", {
                  children: childCount(unit),
                  members: memberCount(unit),
                  workspaces: workspaceCount(unit),
                })}
              </SurfaceListText>
            </SurfaceListItemMain>
            <StatusDot
              tone={STATUS_TONE[unit.status.toUpperCase()] ?? "neutral"}
              label={i18n.t(
                `admin.organization.unit-detail.status.${unit.status.toLowerCase()}` as never,
              )}
            />
          </Group>
        </SelectableCardRow>
        {children.length > 0 ? (
          <Stack component="div" role="list">
            {children.map((child) => renderNode(child, depth + 1, nextSeen))}
          </Stack>
        ) : null}
      </StructureTreeContent>
    );
  };

  return (
    <Stack>
      <SettingsCollectionToolbar
        search={
          <Input
            value={query}
            onChange={setQuery}
            aria-label={i18n.t("admin.actions.search")}
            placeholder={i18n.t(
              "admin.organization.organigram.search-placeholder",
            )}
            preFix={<Search aria-hidden />}
          />
        }
      />
      <Divider />
      <SettingsMasterDetailLayout
        detail={
          <UnitDetail
            key={selectedUnit?.id ?? "empty"}
            unit={selectedUnit}
            units={units}
            types={types}
            catalogSelection={catalogSelection}
            onSaved={mutate}
            onDirtyChange={setDetailDirty}
            onBusyChange={setDetailBusy}
          />
        }
        detailOpen
      >
        <Stack>
          {rootUnits.length === 0 ? (
            <SettingsEmptyState
              title={i18n.t("admin.organization.organigram.empty-title")}
              description={i18n.t("admin.organization.organigram.empty-hint")}
            />
          ) : (
            <StructureTreeRoot data-myoxus-ui-role="organization-organigram-tree">
              <SurfaceList label={i18n.t("admin.organization.tab.organigram")}>
                {rootUnits.map((unit) => renderNode(unit, 0, new Set()))}
              </SurfaceList>
            </StructureTreeRoot>
          )}
        </Stack>
      </SettingsMasterDetailLayout>
      <AdminConfirmModal
        open={pendingUnitId !== null}
        onOpenChange={(open) => {
          if (!open) setPendingUnitId(null);
        }}
        title={i18n.t("admin.unsaved.discard-title")}
        description={i18n.t("admin.unsaved.discard-description")}
        confirmText={i18n.t("admin.common.discard-changes")}
        onConfirm={() => {
          setDetailDirty(false);
          setSelectedUnitId(pendingUnitId);
          setPendingUnitId(null);
        }}
        onCancel={() => setPendingUnitId(null)}
      />
    </Stack>
  );
}
