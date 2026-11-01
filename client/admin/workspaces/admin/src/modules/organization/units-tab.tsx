/**
 * Admin role primitive — Units tab.
 *
 * Filtered OU master/detail surface for the default organisation. The list
 * requests active units by default, while an explicit all-status projection
 * retains the hierarchy context needed by paths and lifecycle editing.
 */
import { OrganizationUnitStatusEnum } from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import {
  CirclePanel,
  CornerDownRight,
  Plus,
  Search,
} from "@myoxus/icons/react";
import {
  Button,
  DialogFooterActions,
  Divider,
  FormSelect,
  Input,
  Modal,
  notify,
  Select,
  SettingsEmptyState,
  SettingsField,
  SettingsCollectionToolbar,
  SettingsMasterDetailLayout,
  Stack,
  StatusDot,
  SurfaceList,
  SurfaceListAction,
  SurfaceListItem,
  SurfaceListItemIcon,
  SurfaceListItemMain,
  SurfaceListMeta,
  SurfaceListText,
} from "@myoxus/ui-facade";
import { useEffect, useMemo, useState } from "react";

import {
  useOrganizationQuery,
  useOrganizationUnitsQuery,
  useOrganizationUnitTypesQuery,
  useUpsertOrganizationUnitMutation,
} from "./api";
import { UnitDetail } from "./unit-detail";
import { AdminConfirmModal } from "../../components/shared/admin-confirm-modal";
import {
  filterUnitTypesForAuthoring,
  getUnitTypeCatalogSelection,
} from "./unit-type-catalog";

const STATUS_TONE: Record<
  OrganizationUnitStatusEnum,
  {
    tone: "neutral" | "success" | "warning" | "error" | "info";
    labelKey:
      | "admin.organization.unit-detail.status.active"
      | "admin.organization.unit-detail.status.disabled"
      | "admin.organization.unit-detail.status.archived";
  }
> = {
  [OrganizationUnitStatusEnum.Active]: {
    tone: "success",
    labelKey: "admin.organization.unit-detail.status.active",
  },
  [OrganizationUnitStatusEnum.Disabled]: {
    tone: "error",
    labelKey: "admin.organization.unit-detail.status.disabled",
  },
  [OrganizationUnitStatusEnum.Archived]: {
    tone: "neutral",
    labelKey: "admin.organization.unit-detail.status.archived",
  },
};

const ROOT_PARENT_VALUE = "__root_parent__";
const ALL_STATUS_VALUE = "__all_statuses__";

export function UnitsTab({ focusUnitId }: { focusUnitId?: string | null }) {
  const i18n = useI18n();
  const { organization } = useOrganizationQuery();
  const [statusFilter, setStatusFilter] = useState<
    OrganizationUnitStatusEnum | typeof ALL_STATUS_VALUE
  >(focusUnitId ? ALL_STATUS_VALUE : OrganizationUnitStatusEnum.Active);
  const { units, mutate } = useOrganizationUnitsQuery(
    statusFilter === ALL_STATUS_VALUE ? null : statusFilter,
  );
  const { units: allUnits, mutate: mutateAllUnits } =
    useOrganizationUnitsQuery(null);
  const { types } = useOrganizationUnitTypesQuery();
  const upsert = useUpsertOrganizationUnitMutation();

  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState("");
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [unitTypeId, setUnitTypeId] = useState("");
  const [parentUnitId, setParentUnitId] = useState("");
  const [selectedUnitId, setSelectedUnitId] = useState<string | null>(
    focusUnitId ?? null,
  );
  const [detailDirty, setDetailDirty] = useState(false);
  const [detailBusy, setDetailBusy] = useState(false);
  const [pendingUnitId, setPendingUnitId] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedUnitId && !focusUnitId && units[0])
      setSelectedUnitId(units[0].id);
  }, [focusUnitId, selectedUnitId, units]);

  useEffect(() => {
    if (focusUnitId) {
      setSelectedUnitId(focusUnitId);
      setStatusFilter(ALL_STATUS_VALUE);
    }
  }, [focusUnitId]);

  const slugByUnit = useMemo(
    () => new Map(allUnits.map((u) => [u.id, u.slug])),
    [allUnits],
  );
  const typeById = useMemo(() => new Map(types.map((t) => [t.id, t])), [types]);
  const catalogSelection = useMemo(
    () => getUnitTypeCatalogSelection(organization?.metadata),
    [organization?.metadata],
  );
  const authoringTypes = useMemo(
    () => filterUnitTypesForAuthoring(types, catalogSelection),
    [catalogSelection, types],
  );
  const activeUnits = useMemo(
    () =>
      allUnits.filter(
        (unit) => unit.status === OrganizationUnitStatusEnum.Active,
      ),
    [allUnits],
  );
  const filtered = units.filter(
    (u) =>
      !query ||
      u.name.toLowerCase().includes(query.toLowerCase()) ||
      u.slug.toLowerCase().includes(query.toLowerCase()),
  );
  const selectedUnit =
    allUnits.find((unit) => unit.id === selectedUnitId) ??
    (focusUnitId && selectedUnitId === focusUnitId
      ? null
      : (filtered[0] ?? null));
  const selectUnit = (id: string) => {
    if (detailBusy || id === selectedUnit?.id) return;
    if (detailDirty) setPendingUnitId(id);
    else setSelectedUnitId(id);
  };

  const refreshUnits = async () => {
    await Promise.all([mutate(), mutateAllUnits()]);
  };

  return (
    <Stack>
      <SettingsCollectionToolbar
        search={
          <Input
            value={query}
            onChange={setQuery}
            aria-label={i18n.t("admin.actions.search")}
            placeholder={i18n.t("admin.organization.units.filter-placeholder")}
            preFix={<Search aria-hidden />}
          />
        }
        filters={
          <FormSelect
            value={statusFilter}
            onChange={(value) =>
              setStatusFilter(
                value as OrganizationUnitStatusEnum | typeof ALL_STATUS_VALUE,
              )
            }
            data-testid="organization-unit-status-filter"
            aria-label={i18n.t("admin.common.status")}
            data={[
              {
                value: OrganizationUnitStatusEnum.Active,
                label: i18n.t("admin.organization.unit-detail.status.active"),
              },
              {
                value: OrganizationUnitStatusEnum.Disabled,
                label: i18n.t("admin.organization.unit-detail.status.disabled"),
              },
              {
                value: OrganizationUnitStatusEnum.Archived,
                label: i18n.t("admin.organization.unit-detail.status.archived"),
              },
              {
                value: ALL_STATUS_VALUE,
                label: i18n.t("admin.organization.units.status-all"),
              },
            ]}
          />
        }
        actions={
          <Button
            variant="primary"
            data-testid="organization-create-unit-button"
            prefix={<Plus aria-hidden />}
            onClick={() => setCreating(true)}
          >
            {i18n.t("admin.organization.units.create")}
          </Button>
        }
      />
      <Divider />
      <SettingsMasterDetailLayout
        detail={
          <UnitDetail
            key={selectedUnit?.id ?? "empty"}
            unit={selectedUnit}
            units={allUnits}
            types={types}
            catalogSelection={catalogSelection}
            onSaved={refreshUnits}
            onDirtyChange={setDetailDirty}
            onBusyChange={setDetailBusy}
          />
        }
        detailOpen
        detailPriority="detail"
        mainTestId="organization-units-master"
        detailTestId="organization-units-detail"
      >
        <Stack>
          <Modal
            open={creating}
            onOpenChange={setCreating}
            title={i18n.t("admin.organization.units.create-title")}
            description={i18n.t("admin.organization.units.create-description")}
            width="lg"
          >
            <Stack>
              <SettingsField
                labelFor="ou-name"
                label={i18n.t("admin.organization.units.name-label")}
              >
                <Input id="ou-name" value={name} onChange={setName} />
              </SettingsField>
              <SettingsField
                labelFor="ou-slug"
                label={i18n.t("admin.organization.units.slug-label")}
              >
                <Input id="ou-slug" value={slug} onChange={setSlug} />
              </SettingsField>
              <SettingsField
                label={i18n.t("admin.organization.units.type-label")}
                description={i18n.t(
                  "admin.organization.units.type-catalog-hint",
                )}
              >
                <Select
                  aria-label={i18n.t("admin.organization.units.type-label")}
                  value={unitTypeId}
                  onChange={setUnitTypeId}
                  data-testid="organization-create-unit-type-select"
                  placeholder={i18n.t(
                    "admin.organization.units.type-placeholder",
                  )}
                  data={authoringTypes.map((t) => ({
                    value: t.id,
                    label: `${t.label} · ${t.key}`,
                  }))}
                  controlMaxWidth="100%"
                />
              </SettingsField>
              <SettingsField
                label={i18n.t("admin.organization.units.parent-label")}
              >
                <Select
                  aria-label={i18n.t("admin.organization.units.parent-label")}
                  value={parentUnitId || ROOT_PARENT_VALUE}
                  onChange={(value) =>
                    setParentUnitId(value === ROOT_PARENT_VALUE ? "" : value)
                  }
                  placeholder={i18n.t(
                    "admin.organization.units.parent-placeholder",
                  )}
                  data={[
                    {
                      value: ROOT_PARENT_VALUE,
                      label: i18n.t("admin.organization.units.parent-none"),
                    },
                    ...activeUnits.map((u) => ({
                      value: u.id,
                      label: `${u.name} · ${u.slug}`,
                    })),
                  ]}
                  controlMaxWidth="100%"
                />
              </SettingsField>
            </Stack>
            <DialogFooterActions>
              <Button
                disabled={!name || !slug || !unitTypeId || upsert.isMutating}
                onClick={async () => {
                  try {
                    await upsert.trigger({
                      input: {
                        unitTypeId,
                        name,
                        slug,
                        parentUnitId: parentUnitId || null,
                      },
                    });
                    notify.success({
                      title: i18n.t("admin.organization.units.created"),
                    });
                    setName("");
                    setSlug("");
                    setUnitTypeId("");
                    setParentUnitId("");
                    setCreating(false);
                    await refreshUnits();
                  } catch (e) {
                    notify.error({ title: String(e) });
                  }
                }}
              >
                {i18n.t("admin.organization.units.create-confirm")}
              </Button>
            </DialogFooterActions>
          </Modal>

          {filtered.length === 0 ? (
            <SettingsEmptyState
              title={i18n.t(
                query.trim()
                  ? "admin.common.no-results-found"
                  : "admin.organization.units.empty-title",
              )}
              description={
                query.trim()
                  ? undefined
                  : i18n.t("admin.organization.units.empty-hint")
              }
            />
          ) : (
            <SurfaceList label={i18n.t("admin.organization.tab.units")}>
              {filtered.map((u) => {
                const active = selectedUnit?.id === u.id;
                const status =
                  STATUS_TONE[u.status] ??
                  STATUS_TONE[OrganizationUnitStatusEnum.Active];
                const type = typeById.get(u.unitTypeId);
                const slugPath = u.parentUnitId
                  ? `${slugByUnit.get(u.parentUnitId) ?? "?"} / ${u.slug}`
                  : u.slug;
                return (
                  <SurfaceListItem
                    component="div"
                    key={u.id}
                    data-testid={`organization-unit-row-${u.id}`}
                    data-active={active ? "true" : undefined}
                    density="compact"
                    selected={active}
                  >
                    <SurfaceListAction
                      type="button"
                      onClick={() => selectUnit(u.id)}
                      data-myoxus-ui-role="button:list-primary-action"
                      selected={active}
                    >
                      <SurfaceListItemIcon>
                        {u.parentUnitId ? (
                          <CornerDownRight aria-hidden />
                        ) : (
                          <CirclePanel
                            aria-label={i18n.t(
                              "admin.organization.unit-detail.parent-root",
                            )}
                          />
                        )}
                      </SurfaceListItemIcon>
                      <SurfaceListItemMain grow>
                        <SurfaceListText kind="title">{u.name}</SurfaceListText>
                        <SurfaceListText kind="description">
                          {type ? `${slugPath} · ${type.label}` : slugPath}
                        </SurfaceListText>
                      </SurfaceListItemMain>
                      <SurfaceListMeta>
                        <StatusDot
                          tone={status.tone}
                          label={i18n.t(status.labelKey)}
                        />
                      </SurfaceListMeta>
                    </SurfaceListAction>
                  </SurfaceListItem>
                );
              })}
            </SurfaceList>
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
