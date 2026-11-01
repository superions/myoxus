/**
 * Templates — Default Policies tab.
 *
 * Lists all template default policies.  Each policy controls whether a template
 * is automatically seeded into newly created workspaces and how the seeding
 * works (selection mode + provisioning mode).
 *
 * Per-row:
 *  - Toggle `applyToNewWorkspaces` (inline, immediate mutation)
 *  - Edit drawer for selection_mode + provisioning_mode (radio groups)
 */
import { ProvisioningModeType, SelectionModeType } from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import { PencilIcon } from "@myoxus/icons/react";
import {
  Button,
  Drawer,
  Group,
  MonoText,
  notify,
  RadioGroup,
  ResponsiveGrid,
  SettingsEmptyState,
  SettingsNotice,
  SettingsSection,
  SettingsSectionHeading,
  SettingsSkeleton,
  SettingsSwitchRow,
  Stack,
} from "@myoxus/ui-facade";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";

import { AdminConfirmModal } from "../../components/shared/admin-confirm-modal";
import { formatAdminDateTime } from "../../utils/locale-format";
import {
  setTemplateDefaultPolicy,
  useTemplateCatalogQuery,
  useTemplateDefaultPoliciesQuery,
  useTemplateRegistryRevalidate,
  useTemplateRevisionsQuery,
} from "./api";
import {
  TemplateEnabledBadge,
  TemplateProvisioningModeBadge,
  templateProvisioningModeLabel,
  TemplateSelectionModeBadge,
  templateSelectionModeKind,
  templateSelectionModeLabel,
} from "./badges";
import { withTemplateErrorContext } from "./error-utils";
import {
  adaptDefaultPolicies,
  type DefaultPolicyViewModel,
} from "./format-adapters";
import { templateDisplayTitle } from "./localized-builtins";
import {
  MetaField,
  MetaGrid,
  SoftList,
  SoftListItem,
  TemplateCardTitle,
  TemplateShoulder,
  TemplateTabFrame,
} from "./template-role-primitives";

// ---------------------------------------------------------------------------
// Edit Drawer
// ---------------------------------------------------------------------------

interface EditDrawerProps {
  policy: DefaultPolicyViewModel | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}

function EditPolicyDrawer({
  policy,
  open,
  onOpenChange,
  onSaved,
}: EditDrawerProps) {
  const i18n = useI18n();
  const [selectionMode, setSelectionMode] = useState<SelectionModeType>(
    SelectionModeType.Published,
  );
  const [provisioningMode, setProvisioningMode] =
    useState<ProvisioningModeType>(ProvisioningModeType.SeedOnce);
  const [isSaving, setIsSaving] = useState(false);
  const { revisions } = useTemplateRevisionsQuery(
    open ? (policy?.templateId ?? null) : null,
    { skip: 0, take: 100 },
  );
  const isGuide =
    revisions.find((revision: any) => revision.state === "Published")?.manifest
      ?.purpose === "guide";

  useEffect(() => {
    if (!open || !policy) return;
    setSelectionMode(
      (policy.selectionMode as SelectionModeType) ??
        SelectionModeType.Published,
    );
    setProvisioningMode(
      (policy.provisioningMode as ProvisioningModeType) ??
        ProvisioningModeType.SeedOnce,
    );
  }, [open, policy]);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      onOpenChange(next);
    },
    [onOpenChange],
  );

  const handleSave = useCallback(async () => {
    if (!policy) return;
    setIsSaving(true);
    try {
      await setTemplateDefaultPolicy({
        templateId: policy.templateId,
        applyToNewWorkspaces: policy.applyToNewWorkspaces,
        selectionMode,
        provisioningMode: isGuide
          ? ProvisioningModeType.SeedOnce
          : provisioningMode,
      });
      notify.success({
        title: i18n.t("admin.templates.default-policies.toast.saved"),
      });
      onOpenChange(false);
      onSaved();
    } catch (e: unknown) {
      notify.error({
        title: withTemplateErrorContext(
          i18n.t("admin.templates.default-policies.toast.save-failed"),
          e,
        ),
      });
    } finally {
      setIsSaving(false);
    }
  }, [
    policy,
    selectionMode,
    provisioningMode,
    isGuide,
    onOpenChange,
    onSaved,
    i18n,
  ]);

  return (
    <Drawer
      open={open}
      onOpenChange={handleOpenChange}
      title={i18n.t("admin.templates.default-policies.title")}
      description={
        policy ? <MonoText>{policy.templateId}</MonoText> : undefined
      }
      size="md"
    >
      <Stack>
        <Stack component="section">
          <SettingsSectionHeading level={3}>
            {i18n.t("admin.templates.default-policies.col.selection")}
          </SettingsSectionHeading>
          <RadioGroup
            value={selectionMode}
            onChange={(value) => setSelectionMode(value as SelectionModeType)}
            items={[
              {
                value: SelectionModeType.Published,
                label: i18n.t(
                  "admin.templates.default-policies.mode.published",
                ),
              },
              {
                value: SelectionModeType.PinnedRevision,
                label: i18n.t("admin.templates.default-policies.mode.pinned"),
              },
            ]}
          />
        </Stack>

        <Stack component="section">
          <SettingsSectionHeading level={3}>
            {i18n.t("admin.templates.default-policies.col.provisioning")}
          </SettingsSectionHeading>
          <RadioGroup
            value={isGuide ? ProvisioningModeType.SeedOnce : provisioningMode}
            disabled={isGuide}
            onChange={(value) =>
              setProvisioningMode(value as ProvisioningModeType)
            }
            items={[
              {
                value: ProvisioningModeType.SeedOnce,
                label: i18n.t(
                  "admin.templates.default-policies.mode.seed-once",
                ),
              },
              {
                value: ProvisioningModeType.ManagedUntilLocalEdit,
                label: i18n.t("admin.templates.default-policies.mode.managed"),
              },
              {
                value: ProvisioningModeType.ManualUpdate,
                label: i18n.t("admin.templates.default-policies.mode.manual"),
              },
            ]}
          />
        </Stack>

        <Group justify="flex-end">
          <Button type="button" onClick={handleSave} disabled={isSaving}>
            {isSaving
              ? i18n.t("admin.common.saving")
              : i18n.t("admin.common.save")}
          </Button>
        </Group>
      </Stack>
    </Drawer>
  );
}

// ---------------------------------------------------------------------------
// Content (inside Suspense)
// ---------------------------------------------------------------------------

function DefaultPoliciesContent() {
  const i18n = useI18n();
  const { policies: raw } = useTemplateDefaultPoliciesQuery();
  const { entries: templates } = useTemplateCatalogQuery({
    skip: 0,
    take: 100,
  });
  const policies = adaptDefaultPolicies(raw as any[]);
  const { revalidateCatalog, revalidateDefaultPolicies } =
    useTemplateRegistryRevalidate();
  const templateById = useMemo(
    () => new Map(templates.map((entry: any) => [entry.id, entry])),
    [templates],
  );

  const [editTarget, setEditTarget] = useState<DefaultPolicyViewModel | null>(
    null,
  );
  const [editOpen, setEditOpen] = useState(false);
  const [toggleTarget, setToggleTarget] =
    useState<DefaultPolicyViewModel | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const openPolicies = policies.filter(
    (policy) => !policy.applyToNewWorkspaces,
  );
  const curatedPolicies = policies.filter(
    (policy) =>
      policy.applyToNewWorkspaces &&
      templateSelectionModeKind(policy.selectionMode) === "published",
  );
  const lockedPolicies = policies.filter(
    (policy) =>
      policy.applyToNewWorkspaces &&
      templateSelectionModeKind(policy.selectionMode) !== "published",
  );
  const policyGroups = [
    {
      key: "open",
      title: i18n.t("admin.templates.default-policies.tableau.open"),
      hint: i18n.t("admin.templates.default-policies.tableau.open-hint"),
      tone: "warning" as const,
      items: openPolicies,
    },
    {
      key: "curated",
      title: i18n.t("admin.templates.default-policies.tableau.curated"),
      hint: i18n.t("admin.templates.default-policies.tableau.curated-hint"),
      tone: "success" as const,
      items: curatedPolicies,
    },
    {
      key: "locked",
      title: i18n.t("admin.templates.default-policies.tableau.locked"),
      hint: i18n.t("admin.templates.default-policies.tableau.locked-hint"),
      tone: "warning" as const,
      items: lockedPolicies,
    },
  ];
  const emptyPolicyGroups = policyGroups.filter(
    (group) => group.items.length === 0,
  );
  const filledPolicyGroups = policyGroups.filter(
    (group) => group.items.length > 0,
  );

  const handleEditOpen = useCallback((policy: DefaultPolicyViewModel) => {
    setEditTarget(policy);
    setEditOpen(true);
  }, []);

  const handleEditSaved = useCallback(() => {
    revalidateDefaultPolicies().catch(() => {});
    revalidateCatalog().catch(() => {});
  }, [revalidateDefaultPolicies, revalidateCatalog]);

  const handleToggleApply = useCallback(
    async (policy: DefaultPolicyViewModel, next: boolean) => {
      setIsSaving(true);
      try {
        await setTemplateDefaultPolicy({
          templateId: policy.templateId,
          applyToNewWorkspaces: next,
          selectionMode: policy.selectionMode as SelectionModeType,
          provisioningMode: policy.provisioningMode as ProvisioningModeType,
        });
        notify.success({
          title: i18n.t("admin.templates.default-policies.toast.saved"),
        });
        await revalidateDefaultPolicies().catch(() => {});
        revalidateCatalog().catch(() => {});
      } catch (e: unknown) {
        notify.error({
          title: withTemplateErrorContext(
            i18n.t("admin.templates.default-policies.toast.save-failed"),
            e,
          ),
        });
      } finally {
        setIsSaving(false);
        setToggleTarget(null);
      }
    },
    [revalidateDefaultPolicies, revalidateCatalog, i18n],
  );

  return (
    <>
      <EditPolicyDrawer
        policy={editTarget}
        open={editOpen}
        onOpenChange={setEditOpen}
        onSaved={handleEditSaved}
      />

      <AdminConfirmModal
        open={toggleTarget !== null}
        onOpenChange={(open) => {
          if (!open) setToggleTarget(null);
        }}
        title={i18n.t("admin.templates.default-policies.col.apply")}
        description={i18n.t("admin.templates.default-policies.description")}
        confirmText={i18n.t("admin.common.confirm")}
        onConfirm={() => {
          if (toggleTarget) {
            handleToggleApply(toggleTarget, !toggleTarget.applyToNewWorkspaces);
          }
        }}
      />

      <TemplateTabFrame
        title={i18n.t("admin.templates.default-policies.title")}
        description={i18n.t("admin.templates.default-policies.description")}
        shoulder={
          <TemplateShoulder
            rows={[
              {
                label: i18n.t("admin.templates.default-policies.metric.total"),
                value: policies.length,
                tone: policies.length > 0 ? "success" : "neutral",
              },
              {
                label: i18n.t(
                  "admin.templates.default-policies.metric.applied",
                ),
                value: curatedPolicies.length + lockedPolicies.length,
                tone:
                  curatedPolicies.length + lockedPolicies.length > 0
                    ? "info"
                    : "neutral",
              },
            ]}
          />
        }
      >
        <Stack>
          {policies.length === 0 ? (
            <SettingsEmptyState
              title={i18n.t("admin.templates.default-policies.empty")}
              description={i18n.t(
                "admin.templates.default-policies.empty-hint",
              )}
            />
          ) : (
            <Stack>
              {emptyPolicyGroups.length > 0 ? (
                <Stack>
                  {emptyPolicyGroups.map((group) => (
                    <SettingsNotice
                      key={group.key}
                      tone="neutral"
                      title={group.title}
                      data-testid={`default-policy-empty-group-${group.key}`}
                    >
                      {group.hint}{" "}
                      {i18n.t("admin.templates.default-policies.tableau.none")}
                    </SettingsNotice>
                  ))}
                </Stack>
              ) : null}

              <ResponsiveGrid
                cols={filledPolicyGroups.length > 1 ? { base: 1, lg: 2 } : 1}
              >
                {filledPolicyGroups.map((group) => (
                  <SettingsSection
                    key={group.key}
                    title={group.title}
                    description={group.hint}
                    component="section"
                  >
                    <div data-testid={`default-policy-group-${group.key}`}>
                      <Stack>
                        <SoftList>
                          {group.items.map((policy) => (
                            <SoftListItem key={policy.templateId}>
                              <Stack>
                                <Group
                                  align="flex-start"
                                  justify="space-between"
                                  wrap="wrap"
                                >
                                  <TemplateCardTitle
                                    title={
                                      templateById.has(policy.templateId)
                                        ? templateDisplayTitle(
                                            i18n,
                                            templateById.get(policy.templateId),
                                          )
                                        : policy.templateId
                                    }
                                    subtitle={i18n.t(
                                      "admin.templates.default-policies.card.subtitle",
                                    )}
                                    mono={formatAdminDateTime(
                                      i18n.language,
                                      policy.updatedAt,
                                    )}
                                  />
                                  <Button
                                    type="button"
                                    variant="plain"
                                    prefix={<PencilIcon />}
                                    onClick={() => handleEditOpen(policy)}
                                  >
                                    {i18n.t("admin.common.edit")}
                                  </Button>
                                </Group>
                                <SettingsSwitchRow
                                  label={i18n.t(
                                    "admin.templates.default-policies.col.apply",
                                  )}
                                  checked={policy.applyToNewWorkspaces}
                                  disabled={isSaving}
                                  onCheckedChange={() => {
                                    setToggleTarget({ ...policy });
                                  }}
                                />
                                <Group align="center" wrap="wrap">
                                  <TemplateEnabledBadge
                                    enabled={policy.applyToNewWorkspaces}
                                  />
                                  <TemplateSelectionModeBadge
                                    mode={policy.selectionMode}
                                  />
                                  <TemplateProvisioningModeBadge
                                    mode={policy.provisioningMode}
                                  />
                                </Group>
                                <MetaGrid>
                                  <MetaField
                                    label={i18n.t(
                                      "admin.templates.default-policies.col.selection",
                                    )}
                                    value={templateSelectionModeLabel(
                                      i18n,
                                      policy.selectionMode,
                                    )}
                                  />
                                  <MetaField
                                    label={i18n.t(
                                      "admin.templates.default-policies.col.provisioning",
                                    )}
                                    value={templateProvisioningModeLabel(
                                      i18n,
                                      policy.provisioningMode,
                                    )}
                                  />
                                </MetaGrid>
                              </Stack>
                            </SoftListItem>
                          ))}
                        </SoftList>
                      </Stack>
                    </div>
                  </SettingsSection>
                ))}
              </ResponsiveGrid>
            </Stack>
          )}
        </Stack>
      </TemplateTabFrame>
    </>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

function DefaultPoliciesSkeleton() {
  return <SettingsSkeleton />;
}

export function DefaultPoliciesTab() {
  return (
    <Suspense fallback={<DefaultPoliciesSkeleton />}>
      <DefaultPoliciesContent />
    </Suspense>
  );
}
