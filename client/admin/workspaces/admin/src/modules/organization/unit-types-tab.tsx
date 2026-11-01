/**
 * Admin role primitive — Unit-Types tab.
 *
 * Organization-model choices use a compact radio-card grid. Unit types are
 * grouped in an accordion so capabilities remain available without turning
 * the page into a wall of cards.
 */
import { useI18n } from "@myoxus/i18n";
import {
  Briefcase,
  Check,
  Crown,
  FileSignature,
  GitBranch,
  Layers,
  Lock,
  Organization,
  Plus,
  ShieldAlert,
  Users,
  Workflow,
} from "@myoxus/icons/react";
import {
  Accordion,
  AccordionControl,
  AccordionItem,
  AccordionPanel,
  Badge,
  BadgeList,
  BadgeListItem,
  Button,
  Checkbox,
  DialogFooterActions,
  Input,
  Modal,
  notify,
  RadioCard,
  RadioCardGroup,
  RadioCardIndicator,
  ResponsiveGrid,
  SelectionCardGrid,
  SettingsEmptyState,
  SettingsField,
  SettingsListItemMeta,
  SettingsListItemTitle,
  SettingsSection,
  SettingsToolbar,
  Stack,
  StatusDot,
  SurfaceListItem,
} from "@myoxus/ui-facade";
import { useMemo, useState } from "react";

import {
  useDeactivateOrganizationUnitTypeMutation,
  useOrganizationQuery,
  useOrganizationUnitTypesQuery,
  useUpdateOrganizationMutation,
  useUpsertOrganizationUnitTypeMutation,
} from "./api";
import {
  countTypesForCatalog,
  filterUnitTypesForAuthoring,
  getUnitTypeCatalogSelection,
  UNIT_TYPE_CATALOGS,
  type UnitTypeCatalogId,
  withUnitTypeCatalogSelection,
} from "./unit-type-catalog";

const FLAGS = [
  {
    key: "isStructural",
    icon: Organization,
    labelKey: "admin.organization.unit-types.flag.structural",
  },
  {
    key: "canHaveChildren",
    icon: GitBranch,
    labelKey: "admin.organization.unit-types.flag.has-children",
  },
  {
    key: "canBeRootLevel",
    icon: Layers,
    labelKey: "admin.organization.unit-types.flag.root-level",
  },
  {
    key: "canBeManagerCreated",
    icon: Workflow,
    labelKey: "admin.organization.unit-types.flag.manager-creatable",
  },
  {
    key: "canHaveCrossUnitMembers",
    icon: Users,
    labelKey: "admin.organization.unit-types.flag.cross-unit-members",
  },
  {
    key: "canOwnWorkspaces",
    icon: Briefcase,
    labelKey: "admin.organization.unit-types.flag.owns-workspaces",
  },
  {
    key: "canManageWorkspaces",
    icon: Crown,
    labelKey: "admin.organization.unit-types.flag.manages-workspaces",
  },
  {
    key: "isStaffUnit",
    icon: FileSignature,
    labelKey: "admin.organization.unit-types.flag.staff",
  },
  {
    key: "requiresAdminApproval",
    icon: ShieldAlert,
    labelKey: "admin.organization.unit-types.flag.needs-approval",
  },
] as const;

type FlagKey = (typeof FLAGS)[number]["key"];
type Form = { key: string; label: string } & Record<FlagKey, boolean>;
type UnitTypeTone = "neutral" | "success" | "warning" | "error" | "info";

const defaultForm = (): Form => ({
  key: "",
  label: "",
  isStructural: false,
  canHaveChildren: true,
  canBeRootLevel: false,
  canBeManagerCreated: false,
  canHaveCrossUnitMembers: false,
  canOwnWorkspaces: true,
  canManageWorkspaces: true,
  isStaffUnit: false,
  requiresAdminApproval: false,
});

function toneToStatus(
  tone: UnitTypeTone,
): "neutral" | "success" | "warning" | "error" | "info" {
  return tone;
}

export function UnitTypesTab() {
  const i18n = useI18n();
  const { organization, mutate: mutateOrganization } = useOrganizationQuery();
  const { types, mutate } = useOrganizationUnitTypesQuery(true);
  const updateOrganization = useUpdateOrganizationMutation();
  const upsert = useUpsertOrganizationUnitTypeMutation();
  const deactivate = useDeactivateOrganizationUnitTypeMutation();
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<Form>(defaultForm);

  const catalogSelection = useMemo(
    () => getUnitTypeCatalogSelection(organization?.metadata),
    [organization?.metadata],
  );

  const catalogCounts = UNIT_TYPE_CATALOGS.map((catalog) => ({
    ...catalog,
    count: countTypesForCatalog(types, catalog.id),
  }));
  const visibleTypes = useMemo(
    () => filterUnitTypesForAuthoring(types, catalogSelection),
    [catalogSelection, types],
  );

  const saveCatalog = async (id: UnitTypeCatalogId) => {
    if (!organization) {
      notify.error({
        title: i18n.t("admin.organization.unit-types.catalog.not-ready"),
      });
      return;
    }
    try {
      await updateOrganization.trigger({
        input: {
          metadata: withUnitTypeCatalogSelection(organization.metadata, id),
        },
      });
      notify.success({ title: i18n.t("admin.state.saved") });
      await mutateOrganization?.();
    } catch (error) {
      notify.error({ title: String(error) });
    }
  };

  return (
    <Stack>
      <SettingsSection
        title={i18n.t("admin.organization.unit-types.catalog.title")}
        description={i18n.t(
          "admin.organization.unit-types.catalog.description",
        )}
      >
        <RadioCardGroup
          value={catalogSelection.id}
          onChange={(value) => void saveCatalog(value as UnitTypeCatalogId)}
          aria-label={i18n.t("admin.organization.unit-types.catalog.title")}
        >
          <SelectionCardGrid columns={3}>
            {catalogCounts.map((catalog) => {
              const active = catalogSelection.id === catalog.id;
              return (
                <RadioCard
                  key={catalog.id}
                  value={catalog.id}
                  data-testid={`organization-unit-type-catalog-${catalog.id}`}
                  data-count={catalog.count}
                  data-active={active ? "true" : "false"}
                  disabled={updateOrganization.isMutating || !organization}
                  selected={active}
                  aria-label={i18n.t(
                    "admin.organization.unit-types.catalog.select-aria",
                    { name: i18n.t(catalog.nameKey as never) },
                  )}
                >
                  <Stack>
                    <SettingsToolbar justify="space-between">
                      <SettingsToolbar justify="flex-start">
                        <RadioCardIndicator />
                        <SettingsListItemTitle>
                          {i18n.t(catalog.nameKey as never)}
                        </SettingsListItemTitle>
                      </SettingsToolbar>
                      <StatusDot
                        tone={toneToStatus(catalog.tone)}
                        label={i18n.t(
                          active
                            ? "admin.organization.unit-types.catalog.selected"
                            : "admin.organization.unit-types.package-count",
                          { count: catalog.count },
                        )}
                      />
                    </SettingsToolbar>
                    <SettingsListItemMeta>
                      {i18n.t(catalog.descriptionKey as never)}
                    </SettingsListItemMeta>
                    {active ? (
                      <Badge tone="info">
                        <Check aria-hidden="true" />
                        {i18n.t("admin.organization.unit-types.catalog.active")}
                      </Badge>
                    ) : null}
                  </Stack>
                </RadioCard>
              );
            })}
          </SelectionCardGrid>
        </RadioCardGroup>
      </SettingsSection>

      <SettingsSection
        title={i18n.t("admin.organization.unit-types.summary", {
          count: visibleTypes.length,
        })}
        actions={
          <Button
            data-testid="organization-create-unit-type-button"
            prefix={<Plus aria-hidden />}
            onClick={() => setCreating(true)}
          >
            {i18n.t("admin.organization.unit-types.create")}
          </Button>
        }
      >
        <Modal
          open={creating}
          onOpenChange={setCreating}
          title={i18n.t("admin.organization.unit-types.create-title")}
          width="xl"
        >
          <Stack>
            <ResponsiveGrid cols={{ base: 1, sm: 2 }}>
              <SettingsField
                label={i18n.t("admin.organization.unit-types.key-label")}
              >
                <Input
                  id="utype-key"
                  value={form.key}
                  onChange={(value) => setForm((p) => ({ ...p, key: value }))}
                  mono
                />
              </SettingsField>
              <SettingsField
                label={i18n.t("admin.organization.unit-types.label-label")}
              >
                <Input
                  id="utype-label"
                  value={form.label}
                  onChange={(value) => setForm((p) => ({ ...p, label: value }))}
                />
              </SettingsField>
            </ResponsiveGrid>

            <SettingsField
              label={i18n.t("admin.organization.unit-types.capabilities")}
            >
              <ResponsiveGrid cols={{ base: 1, sm: 2 }}>
                {FLAGS.map(({ key, icon: Icon, labelKey }) => (
                  <SurfaceListItem key={key} component="label" interactive>
                    <Checkbox
                      checked={form[key]}
                      onChange={(_, checked) =>
                        setForm((p) => ({ ...p, [key]: checked }))
                      }
                    />
                    <Icon aria-hidden />
                    <SettingsListItemMeta>
                      {i18n.t(labelKey)}
                    </SettingsListItemMeta>
                  </SurfaceListItem>
                ))}
              </ResponsiveGrid>
            </SettingsField>
          </Stack>
          <DialogFooterActions>
            <Button
              disabled={!form.key || !form.label || upsert.isMutating}
              onClick={async () => {
                try {
                  await upsert.trigger({ input: { ...form } });
                  notify.success({
                    title: i18n.t("admin.organization.unit-types.created"),
                  });
                  setForm(defaultForm());
                  setCreating(false);
                  await mutate();
                } catch (e) {
                  notify.error({ title: String(e) });
                }
              }}
            >
              {i18n.t("admin.organization.unit-types.create-confirm")}
            </Button>
          </DialogFooterActions>
        </Modal>

        {visibleTypes.length === 0 ? (
          <SettingsEmptyState
            title={i18n.t("admin.organization.unit-types.empty-title")}
            description={i18n.t("admin.organization.unit-types.empty-hint")}
          />
        ) : (
          <Accordion variant="contained" multiple>
            {visibleTypes.map((t) => (
              <AccordionItem key={t.id} value={t.id}>
                <AccordionControl>
                  <SettingsToolbar justify="space-between">
                    <Stack>
                      <SettingsListItemTitle>{t.label}</SettingsListItemTitle>
                      <SettingsListItemMeta>{t.key}</SettingsListItemMeta>
                    </Stack>
                    {t.isPreset ? (
                      <StatusDot
                        tone="warning"
                        label={i18n.t("admin.organization.unit-types.preset")}
                      />
                    ) : t.isActive ? (
                      <StatusDot
                        tone="success"
                        label={i18n.t("admin.state.active")}
                      />
                    ) : (
                      <StatusDot
                        tone="error"
                        label={i18n.t("admin.state.inactive")}
                      />
                    )}
                  </SettingsToolbar>
                </AccordionControl>
                <AccordionPanel>
                  <Stack>
                    <BadgeList>
                      {FLAGS.map(({ key, icon: Icon, labelKey }) => {
                        const on = (t as Record<string, unknown>)[key] === true;
                        return (
                          <BadgeListItem key={key}>
                            <Badge
                              tone={on ? "success" : "neutral"}
                              aria-label={`${i18n.t(labelKey)}: ${
                                on
                                  ? i18n.t("admin.state.active")
                                  : i18n.t("admin.common.disabled")
                              }`}
                            >
                              <Icon aria-hidden="true" />
                              {i18n.t(labelKey)}
                            </Badge>
                          </BadgeListItem>
                        );
                      })}
                    </BadgeList>
                    {t.isPreset ? (
                      <SettingsListItemMeta>
                        <Lock aria-hidden />
                        {i18n.t(
                          "admin.organization.unit-types.migration-seeded",
                        )}
                      </SettingsListItemMeta>
                    ) : (
                      <SettingsToolbar justify="flex-end">
                        <Button
                          type="button"
                          variant="destructive"
                          disabled={!t.isActive || deactivate.isMutating}
                          onClick={async () => {
                            try {
                              await deactivate.trigger({ id: t.id });
                              notify.success({
                                title: i18n.t(
                                  "admin.organization.unit-types.deactivated",
                                ),
                              });
                              await mutate();
                            } catch (e) {
                              notify.error({ title: String(e) });
                            }
                          }}
                        >
                          {i18n.t("admin.organization.unit-types.deactivate")}
                        </Button>
                      </SettingsToolbar>
                    )}
                  </Stack>
                </AccordionPanel>
              </AccordionItem>
            ))}
          </Accordion>
        )}
      </SettingsSection>
    </Stack>
  );
}
