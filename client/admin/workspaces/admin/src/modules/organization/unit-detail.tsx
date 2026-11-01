// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Admin role primitive — Unit detail panel.
 *
 * P-AR-2-01 establishes the durable master/detail shell for organization
 * units. P-AR-2-02 makes the master-data tab write-capable without creating a
 * parallel edit drawer: the selected OU owns its form state, validates parent
 * moves locally where possible, and persists through the existing audited
 * organization-unit upsert path. Raw event keys stay diagnostic-only.
 */
import {
  type AdminAuditLogQuery,
  type AdminOrganizationUnitMembersQuery,
  type AdminOrganizationUnitsQuery,
  type AdminOrganizationUnitTypesQuery,
  type AdminOrganizationUnitWorkspacesQuery,
  OrganizationUnitRoleEnum,
  OrganizationUnitStatusEnum,
  OrganizationUnitWorkspaceRelationshipEnum,
} from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import {
  Briefcase,
  ExternalLink,
  RefreshCw,
  RotateCcw,
  Save,
  Trash2,
  UserMinus,
  UserPlus,
} from "@myoxus/icons/react";
import { ROUTES } from "@myoxus/routes";
import {
  Avatar,
  Badge,
  Box,
  Button,
  ErrorMessage,
  FormSelect,
  Group,
  IconButton,
  InlineLink,
  Input,
  notify,
  ResponsiveGrid,
  SelectableCardRow,
  SettingsDefinitionItem,
  SettingsDefinitionList,
  SettingsDetailHeader,
  SettingsEmptyState,
  SettingsField,
  SettingsListItemMeta,
  SettingsListItemTitle,
  SettingsNotice,
  SettingsSection,
  SettingsSectionHeading,
  SettingsStatusText,
  SettingsToolbar,
  Stack,
  StatusDot,
  SurfaceList,
  SurfaceListItem,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
} from "@myoxus/ui-facade";
import type React from "react";
import { useEffect, useId, useMemo, useRef, useState } from "react";

import {
  OuPicker,
  UserPicker,
  WorkspacePicker,
} from "../../components/domain-pickers";
import { AdminConfirmModal } from "../../components/shared/admin-confirm-modal";
import { AdminTypeConfirmModal } from "../../components/shared/admin-type-confirm-modal";
import { eventLabel } from "../audit-log/audit-labels";
import {
  useAssignOrganizationManagerMutation,
  useAssignOrganizationUnitWorkspaceMutation,
  useDeleteOrganizationUnitPermanentlyMutation,
  useOrganizationUnitAuditLogQuery,
  useOrganizationUnitDeletionPreviewQuery,
  useOrganizationUnitMembersQuery,
  useOrganizationUnitWorkspacesQuery,
  useUnassignOrganizationManagerMutation,
  useUnassignOrganizationUnitWorkspaceMutation,
  useUpsertOrganizationUnitMutation,
} from "./api";
import {
  DEFAULT_UNIT_TYPE_CATALOG_SELECTION,
  filterUnitTypesForAuthoring,
  type UnitTypeCatalogSelection,
} from "./unit-type-catalog";

type Unit = AdminOrganizationUnitsQuery["admin"]["organizationUnits"][number];
type UnitType =
  AdminOrganizationUnitTypesQuery["admin"]["organizationUnitTypes"][number];
type WorkspaceLink =
  AdminOrganizationUnitWorkspacesQuery["admin"]["organizationUnitWorkspaces"][number];
type AuditEntry = AdminAuditLogQuery["admin"]["adminAuditLog"][number];
type FacadeStatusTone = "neutral" | "success" | "warning" | "error" | "info";

const STATUS_TONE: Record<
  OrganizationUnitStatusEnum,
  { statusTone: FacadeStatusTone }
> = {
  [OrganizationUnitStatusEnum.Active]: {
    statusTone: "success",
  },
  [OrganizationUnitStatusEnum.Disabled]: {
    statusTone: "error",
  },
  [OrganizationUnitStatusEnum.Archived]: {
    statusTone: "neutral",
  },
};

const STATUS_LABEL_KEY = {
  [OrganizationUnitStatusEnum.Active]:
    "admin.organization.unit-detail.status.active",
  [OrganizationUnitStatusEnum.Disabled]:
    "admin.organization.unit-detail.status.disabled",
  [OrganizationUnitStatusEnum.Archived]:
    "admin.organization.unit-detail.status.archived",
} as const;

const ROLE_LABEL_KEY = {
  [OrganizationUnitRoleEnum.Reader]:
    "admin.organization.unit-detail.members.role.reader",
  [OrganizationUnitRoleEnum.Member]:
    "admin.organization.unit-detail.members.role.member",
  [OrganizationUnitRoleEnum.Manager]:
    "admin.organization.unit-detail.members.role.manager",
} as const;

const WORKSPACE_RELATIONSHIP_LABEL_KEY = {
  [OrganizationUnitWorkspaceRelationshipEnum.Owner]:
    "admin.organization.unit-detail.workspaces.relationship.owner",
  [OrganizationUnitWorkspaceRelationshipEnum.Managed]:
    "admin.organization.unit-detail.workspaces.relationship.managed",
  [OrganizationUnitWorkspaceRelationshipEnum.Linked]:
    "admin.organization.unit-detail.workspaces.relationship.linked",
} as const;

const MEMBER_ROLE_OPTIONS = [
  OrganizationUnitRoleEnum.Reader,
  OrganizationUnitRoleEnum.Member,
  OrganizationUnitRoleEnum.Manager,
] as const;

const WORKSPACE_RELATIONSHIP_OPTIONS = [
  OrganizationUnitWorkspaceRelationshipEnum.Owner,
  OrganizationUnitWorkspaceRelationshipEnum.Managed,
  OrganizationUnitWorkspaceRelationshipEnum.Linked,
] as const;

const DETAIL_TABS = [
  {
    value: "master-data",
    labelKey: "admin.organization.unit-detail.tab.master-data",
  },
  {
    value: "members",
    labelKey: "admin.organization.unit-detail.tab.members",
  },
  {
    value: "workspaces",
    labelKey: "admin.organization.unit-detail.tab.workspaces",
  },
  { value: "quota", labelKey: "admin.organization.unit-detail.tab.quota" },
  { value: "audit", labelKey: "admin.organization.unit-detail.tab.audit" },
  {
    value: "settings",
    labelKey: "admin.organization.unit-detail.tab.settings",
  },
] as const;

function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  return <SettingsDefinitionItem label={label}>{value}</SettingsDefinitionItem>;
}

function FactList({
  children,
  testId,
}: {
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <SettingsDefinitionList data-testid={testId}>
      {children}
    </SettingsDefinitionList>
  );
}

function formatDate(i18n: ReturnType<typeof useI18n>, value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(i18n.language, {
    year: "numeric",
    month: "short",
    day: "2-digit",
  }).format(date);
}

function deletionBlockerLabel(i18n: ReturnType<typeof useI18n>, code: string) {
  switch (code) {
    case "CHILD_UNITS":
      return i18n.t("admin.organization.tab.units");
    case "MEMBERS":
      return i18n.t("admin.organization.tab.members");
    case "WORKSPACE_LINKS":
      return i18n.t("admin.organization.unit-detail.tab.workspaces");
    case "OWNER_PRINCIPAL_WORKSPACES":
      return i18n.t(
        "admin.organization.unit-detail.deletion.blocker.owner-workspaces",
      );
    case "MANAGEMENT_UNIT_WORKSPACES":
      return i18n.t(
        "admin.organization.unit-detail.deletion.blocker.managed-workspaces",
      );
    case "PROJECT_REQUESTS":
      return i18n.t("admin.organization.tab.requests");
    case "OIDC_GROUP_MAPPINGS":
      return i18n.t(
        "admin.organization.unit-detail.deletion.blocker.oidc-mappings",
      );
    default:
      return i18n.t("admin.organization.unit-detail.deletion.blocker.unknown");
  }
}

function formatBytes(
  value: number | null | undefined,
  fallback: string,
  unlimited: string,
) {
  if (value === null || value === undefined) return fallback;
  if (value === 0) return unlimited;
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let size = Math.max(0, value);
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size >= 10 || unit === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[unit]}`;
}

function auditEntryJson(entry: AuditEntry) {
  return JSON.stringify(
    {
      oldValue: entry.oldValue,
      newValue: entry.newValue,
      metadata: entry.metadata,
      targetUnitId: entry.targetUnitId,
    },
    null,
    2,
  );
}

function isDescendantOf(
  candidateId: string,
  ancestorId: string,
  units: Unit[],
) {
  let cursor = units.find((unit) => unit.id === candidateId) ?? null;
  const seen = new Set<string>();
  while (cursor?.parentUnitId) {
    if (cursor.parentUnitId === ancestorId) return true;
    if (seen.has(cursor.parentUnitId)) return true;
    seen.add(cursor.parentUnitId);
    cursor = units.find((unit) => unit.id === cursor?.parentUnitId) ?? null;
  }
  return false;
}

function statusOptionsFor(unit: Unit) {
  switch (unit.status) {
    case OrganizationUnitStatusEnum.Active:
      return [
        OrganizationUnitStatusEnum.Active,
        OrganizationUnitStatusEnum.Disabled,
        OrganizationUnitStatusEnum.Archived,
      ];
    case OrganizationUnitStatusEnum.Disabled:
      return [
        OrganizationUnitStatusEnum.Disabled,
        OrganizationUnitStatusEnum.Active,
        OrganizationUnitStatusEnum.Archived,
      ];
    case OrganizationUnitStatusEnum.Archived:
      return [
        OrganizationUnitStatusEnum.Archived,
        OrganizationUnitStatusEnum.Active,
      ];
  }
}

export function UnitDetail({
  unit,
  units,
  types,
  catalogSelection,
  onSaved,
  onDirtyChange,
  onBusyChange,
}: {
  unit: Unit | null;
  units: Unit[];
  types: UnitType[];
  catalogSelection?: UnitTypeCatalogSelection;
  onSaved?: () => Promise<unknown> | unknown;
  onDirtyChange?: (dirty: boolean) => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const i18n = useI18n();
  const { members, mutate: mutateMembers } = useOrganizationUnitMembersQuery(
    unit?.id ?? "",
  );
  const { entries: auditEntries, totalCount: auditTotalCount } =
    useOrganizationUnitAuditLogQuery(unit?.id ?? "");
  const { links, mutate: mutateWorkspaces } =
    useOrganizationUnitWorkspacesQuery(unit?.id ?? "");
  const upsert = useUpsertOrganizationUnitMutation();
  const assignMember = useAssignOrganizationManagerMutation();
  const unassignMember = useUnassignOrganizationManagerMutation();
  const assignWorkspace = useAssignOrganizationUnitWorkspaceMutation();
  const unassignWorkspace = useUnassignOrganizationUnitWorkspaceMutation();
  const deleteUnit = useDeleteOrganizationUnitPermanentlyMutation();
  const fieldId = useId();
  const [deletionPreviewEnabled, setDeletionPreviewEnabled] = useState(false);
  const {
    preview: deletionPreview,
    mutate: mutateDeletionPreview,
    isLoading: deletionPreviewLoading,
  } = useOrganizationUnitDeletionPreviewQuery(
    unit?.id ?? "",
    deletionPreviewEnabled,
  );

  const [name, setName] = useState(unit?.name ?? "");
  const [unitTypeId, setUnitTypeId] = useState(unit?.unitTypeId ?? "");
  const [parentUnitId, setParentUnitId] = useState<string | null>(
    unit?.parentUnitId ?? null,
  );
  const [statusValue, setStatusValue] = useState<OrganizationUnitStatusEnum>(
    (unit?.status as OrganizationUnitStatusEnum) ??
      OrganizationUnitStatusEnum.Active,
  );
  const [newMemberId, setNewMemberId] = useState<string | null>(null);
  const [newMemberRole, setNewMemberRole] = useState<OrganizationUnitRoleEnum>(
    OrganizationUnitRoleEnum.Member,
  );
  const [removeMemberId, setRemoveMemberId] = useState<string | null>(null);
  const [newWorkspaceId, setNewWorkspaceId] = useState<string | null>(null);
  const [newWorkspaceRelationship, setNewWorkspaceRelationship] =
    useState<OrganizationUnitWorkspaceRelationshipEnum>(
      OrganizationUnitWorkspaceRelationshipEnum.Managed,
    );
  const [removeWorkspaceLink, setRemoveWorkspaceLink] =
    useState<WorkspaceLink | null>(null);
  const [quotaMemberLimit, setQuotaMemberLimit] = useState(
    unit ? String(unit.maxMembers) : "",
  );
  const [selectedAuditEntry, setSelectedAuditEntry] =
    useState<AuditEntry | null>(null);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const initializedUnit = useRef<Unit | null>(unit);
  const [baseline, setBaseline] = useState(unit);
  const masterDirty = Boolean(
    baseline &&
    (name !== baseline.name ||
      unitTypeId !== baseline.unitTypeId ||
      parentUnitId !== (baseline.parentUnitId ?? null) ||
      statusValue !== baseline.status),
  );
  const quotaDirty = Boolean(
    baseline && quotaMemberLimit !== String(baseline.maxMembers),
  );
  const draftDirty =
    masterDirty || quotaDirty || !!newMemberId || !!newWorkspaceId;
  const dirtyRef = useRef(draftDirty);
  dirtyRef.current = draftDirty;
  const busy =
    upsert.isMutating ||
    assignMember.isMutating ||
    unassignMember.isMutating ||
    assignWorkspace.isMutating ||
    unassignWorkspace.isMutating ||
    deleteUnit.isMutating;

  useEffect(() => onDirtyChange?.(draftDirty), [draftDirty, onDirtyChange]);
  useEffect(() => onBusyChange?.(busy), [busy, onBusyChange]);

  useEffect(() => {
    if (!unit) return;
    // Activity reactivation must not reset a draft; background readback for the
    // same owner also preserves it until an explicit save or discard.
    if (initializedUnit.current === unit) return;
    if (initializedUnit.current?.id === unit.id && dirtyRef.current) return;
    initializedUnit.current = unit;
    setBaseline(unit);
    setName(unit.name);
    setUnitTypeId(unit.unitTypeId);
    setParentUnitId(unit.parentUnitId ?? null);
    setStatusValue(unit.status as OrganizationUnitStatusEnum);
    setNewMemberId(null);
    setRemoveMemberId(null);
    setNewWorkspaceId(null);
    setNewWorkspaceRelationship(
      OrganizationUnitWorkspaceRelationshipEnum.Managed,
    );
    setRemoveWorkspaceLink(null);
    setSelectedAuditEntry(null);
    setDeletionPreviewEnabled(false);
    setDeleteConfirmOpen(false);
    setQuotaMemberLimit(String(unit.maxMembers));
  }, [unit]);

  const type = types.find((candidate) => candidate.id === unit?.unitTypeId);
  const effectiveCatalogSelection =
    catalogSelection ?? DEFAULT_UNIT_TYPE_CATALOG_SELECTION;
  const selectableTypes = useMemo(
    () =>
      filterUnitTypesForAuthoring(
        types,
        effectiveCatalogSelection,
        unit?.unitTypeId,
      ),
    [effectiveCatalogSelection, types, unit?.unitTypeId],
  );
  const currentTypeOutsideCatalog = !!(
    unit &&
    type &&
    effectiveCatalogSelection.id !== "all" &&
    !filterUnitTypesForAuthoring(types, effectiveCatalogSelection).some(
      (candidate) => candidate.id === unit.unitTypeId,
    )
  );
  const auditHref = unit
    ? `${ROUTES.admin.auditLog}?target_unit_id=${encodeURIComponent(unit.id)}`
    : ROUTES.admin.auditLog;
  const parent = unit?.parentUnitId
    ? units.find((candidate) => candidate.id === unit.parentUnitId)
    : null;
  const selectedParent = parentUnitId
    ? units.find((candidate) => candidate.id === parentUnitId)
    : null;
  const status = unit
    ? (STATUS_TONE[unit.status as OrganizationUnitStatusEnum] ??
      STATUS_TONE[OrganizationUnitStatusEnum.Active])
    : STATUS_TONE[OrganizationUnitStatusEnum.Active];

  const statusOptions = useMemo(
    () => (unit ? statusOptionsFor(unit) : [OrganizationUnitStatusEnum.Active]),
    [unit],
  );
  const workspaceQuotaSummary = useMemo(() => {
    return {
      total: links.length,
      usedBytes: links.reduce(
        (sum, link) => sum + (link.storageUsedBytes ?? 0),
        0,
      ),
    };
  }, [links]);
  const unitQuotaSummary = useMemo(() => {
    const effectiveQuotaBytes = links.reduce(
      (sum, link) => sum + (link.effectiveQuotaBytes ?? 0),
      0,
    );
    const usedBytes = links.reduce(
      (sum, link) => sum + (link.storageUsedBytes ?? 0),
      0,
    );
    return {
      usedBytes,
      effectiveQuotaBytes,
      maxMembers: unit?.maxMembers ?? null,
    };
  }, [links, unit?.maxMembers]);

  if (!unit) {
    return (
      <SettingsSection
        component="section"
        data-testid="unit-detail-empty"
        title={i18n.t("admin.organization.unit-detail.empty-title")}
        description={i18n.t("admin.organization.unit-detail.empty-hint")}
      />
    );
  }

  const dirty = masterDirty;
  const canSave = name.trim().length > 0 && unitTypeId.length > 0;
  const unitTypeSelectOptions = selectableTypes.map((candidate) => ({
    value: candidate.id,
    label: `${candidate.label} · ${candidate.key}`,
  }));
  const statusSelectOptions = statusOptions.map((option) => ({
    value: option,
    label: i18n.t(STATUS_LABEL_KEY[option]),
  }));
  const memberRoleSelectOptions = MEMBER_ROLE_OPTIONS.map((role) => ({
    value: role,
    label: i18n.t(ROLE_LABEL_KEY[role]),
  }));
  const workspaceRelationshipSelectOptions = WORKSPACE_RELATIONSHIP_OPTIONS.map(
    (option) => ({
      value: option,
      label: i18n.t(WORKSPACE_RELATIONSHIP_LABEL_KEY[option]),
    }),
  );
  const reset = () => {
    setBaseline(unit);
    setName(unit.name);
    setUnitTypeId(unit.unitTypeId);
    setParentUnitId(unit.parentUnitId ?? null);
    setStatusValue(unit.status as OrganizationUnitStatusEnum);
  };

  const saveMasterData = async () => {
    if (!canSave) return;
    if (parentUnitId === unit.id) {
      notify.error({
        title: i18n.t("admin.organization.unit-detail.parent-self-error"),
      });
      return;
    }
    if (parentUnitId && isDescendantOf(parentUnitId, unit.id, units)) {
      notify.error({
        title: i18n.t("admin.organization.unit-detail.parent-cycle-error"),
      });
      return;
    }

    try {
      const savedName = name.trim();
      await upsert.trigger({
        input: {
          id: unit.id,
          name: savedName,
          slug: unit.slug,
          description: unit.description,
          unitTypeId,
          parentUnitId,
          status: statusValue,
          maxMembers: unit.maxMembers,
          metadata: unit.metadata ?? {},
        },
      });
      await onSaved?.();
      setBaseline((current) =>
        current
          ? {
              ...current,
              name: savedName,
              unitTypeId,
              parentUnitId,
              status: statusValue,
            }
          : current,
      );
      setName(savedName);
      notify.success({ title: i18n.t("admin.actions.save-success") });
    } catch (error) {
      notify.error({ title: String(error) });
    }
  };

  const saveMemberRole = async (
    userId: string,
    role: OrganizationUnitRoleEnum,
  ) => {
    // Inline role edits should feel immediate, but the server remains
    // authoritative for capability side effects and audit emission.
    await mutateMembers?.(
      (current?: AdminOrganizationUnitMembersQuery) =>
        current
          ? {
              ...current,
              admin: {
                ...current.admin,
                organizationUnitMembers:
                  current.admin.organizationUnitMembers.map((member) =>
                    member.userId === userId ? { ...member, role } : member,
                  ),
              },
            }
          : current,
      { revalidate: false },
    );
    try {
      await assignMember.trigger({
        input: {
          unitId: unit.id,
          userId,
          role,
        },
      });
      notify.success({
        title: i18n.t("admin.organization.unit-detail.members.save-success"),
      });
      await mutateMembers?.();
      await onSaved?.();
    } catch (error) {
      await mutateMembers?.();
      notify.error({ title: String(error) });
    }
  };

  const addMember = async () => {
    if (!newMemberId) return;
    await saveMemberRole(newMemberId, newMemberRole);
    setNewMemberId(null);
    setNewMemberRole(OrganizationUnitRoleEnum.Member);
  };

  const removeMember = async () => {
    if (!removeMemberId) return;
    try {
      await unassignMember.trigger({
        unitId: unit.id,
        userId: removeMemberId,
      });
      notify.success({
        title: i18n.t("admin.organization.unit-detail.members.removed"),
      });
      setRemoveMemberId(null);
      await mutateMembers?.();
      await onSaved?.();
    } catch (error) {
      notify.error({ title: String(error) });
    }
  };

  const addWorkspace = async () => {
    if (!newWorkspaceId) return;
    try {
      await assignWorkspace.trigger({
        input: {
          unitId: unit.id,
          workspaceId: newWorkspaceId,
          relationship: newWorkspaceRelationship,
        },
      });
      notify.success({
        title: i18n.t("admin.organization.unit-detail.workspaces.added"),
      });
      setNewWorkspaceId(null);
      setNewWorkspaceRelationship(
        OrganizationUnitWorkspaceRelationshipEnum.Managed,
      );
      await mutateWorkspaces?.();
      await onSaved?.();
    } catch (error) {
      notify.error({ title: String(error) });
    }
  };

  const saveWorkspaceRelationship = async (
    link: WorkspaceLink,
    relationship: OrganizationUnitWorkspaceRelationshipEnum,
  ) => {
    if (relationship === link.relationship) return;
    await mutateWorkspaces?.(
      (current?: AdminOrganizationUnitWorkspacesQuery) =>
        current
          ? {
              ...current,
              admin: {
                ...current.admin,
                organizationUnitWorkspaces:
                  current.admin.organizationUnitWorkspaces.map((candidate) =>
                    candidate.workspaceId === link.workspaceId
                      ? { ...candidate, relationship }
                      : candidate,
                  ),
              },
            }
          : current,
      { revalidate: false },
    );
    try {
      await assignWorkspace.trigger({
        input: {
          unitId: unit.id,
          workspaceId: link.workspaceId,
          relationship,
        },
      });
      notify.success({
        title: i18n.t("admin.actions.save-success"),
      });
      await mutateWorkspaces?.();
      await onSaved?.();
    } catch (error) {
      await mutateWorkspaces?.();
      notify.error({ title: String(error) });
    }
  };

  const removeWorkspace = async () => {
    if (!removeWorkspaceLink) return;
    try {
      await unassignWorkspace.trigger({
        unitId: unit.id,
        workspaceId: removeWorkspaceLink.workspaceId,
        relationship: removeWorkspaceLink.relationship,
      });
      notify.success({
        title: i18n.t("admin.organization.unit-detail.workspaces.removed"),
      });
      setRemoveWorkspaceLink(null);
      await mutateWorkspaces?.();
      await onSaved?.();
    } catch (error) {
      notify.error({ title: String(error) });
    }
  };

  const saveUnitQuotaSettings = async () => {
    const memberLimit = Number(quotaMemberLimit.trim());
    if (!Number.isInteger(memberLimit) || memberLimit <= 0) {
      notify.error({
        title: i18n.t("admin.organization.unit-detail.quota.limit-invalid"),
      });
      return;
    }
    try {
      await upsert.trigger({
        input: {
          id: unit.id,
          name: unit.name,
          slug: unit.slug,
          description: unit.description,
          unitTypeId: unit.unitTypeId,
          parentUnitId: unit.parentUnitId,
          status: unit.status as OrganizationUnitStatusEnum,
          maxMembers: memberLimit,
          metadata: unit.metadata ?? {},
        },
      });
      notify.success({
        title: i18n.t("admin.organization.unit-detail.quota.save-success"),
      });
      await onSaved?.();
      setBaseline((current) =>
        current ? { ...current, maxMembers: memberLimit } : current,
      );
    } catch (error) {
      notify.error({ title: String(error) });
    }
  };

  const confirmPermanentDelete = async () => {
    if (!deletionPreview?.deletable) return;
    try {
      await deleteUnit.trigger({
        id: unit.id,
        confirmedName: unit.name,
        previewRevision: deletionPreview.updatedAt,
      });
      setDeleteConfirmOpen(false);
      setDeletionPreviewEnabled(false);
      notify.success({
        title: i18n.t("admin.organization.unit-detail.deletion.delete-success"),
      });
      await onSaved?.();
    } catch (error) {
      await mutateDeletionPreview?.();
      notify.error({ title: String(error) });
    }
  };

  return (
    <Stack
      component="section"
      data-testid="unit-detail"
      aria-label={i18n.t("admin.organization.unit-detail.aria-label", {
        name: unit.name,
      })}
    >
      <SettingsDetailHeader
        title={unit.name}
        headingLevel={2}
        description={`${parent ? `${parent.slug} / ` : ""}${unit.slug}`}
        actions={
          <StatusDot
            tone={status.statusTone}
            label={i18n.t(
              STATUS_LABEL_KEY[unit.status as OrganizationUnitStatusEnum],
            )}
          />
        }
      />

      <Tabs defaultValue="master-data" layout="embedded" variant="default">
        <TabsList>
          {DETAIL_TABS.map(({ value, labelKey }) => (
            <TabsTrigger
              key={value}
              value={value}
              data-testid={`unit-detail-tab-${value}`}
            >
              {i18n.t(labelKey)}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent
          value="master-data"
          layout="stack"
          flush
          data-testid="unit-detail-master-form"
        >
          <ResponsiveGrid cols={{ base: 1, sm: 2 }}>
            <SettingsField
              labelFor={`${fieldId}-name`}
              label={i18n.t("admin.organization.unit-detail.field.name")}
            >
              <Input
                id={`${fieldId}-name`}
                data-testid="unit-detail-name-input"
                disabled={upsert.isMutating}
                value={name}
                onChange={setName}
              />
            </SettingsField>

            <SettingsField
              labelFor={`${fieldId}-slug`}
              label={i18n.t("admin.organization.unit-detail.field.slug")}
            >
              <Input
                id={`${fieldId}-slug`}
                data-testid="unit-detail-slug-input"
                value={unit.slug}
                readOnly
                mono
              />
            </SettingsField>

            <Stack>
              <FormSelect
                label={i18n.t("admin.organization.unit-detail.field.type")}
                value={unitTypeId}
                onChange={setUnitTypeId}
                data={unitTypeSelectOptions}
                data-testid="unit-detail-type-select"
                disabled={upsert.isMutating}
                allowDeselect={false}
              />
              {currentTypeOutsideCatalog ? (
                <ErrorMessage role="alert">
                  {i18n.t(
                    "admin.organization.unit-detail.type-outside-catalog",
                  )}
                </ErrorMessage>
              ) : null}
            </Stack>

            <FormSelect
              label={i18n.t("admin.organization.unit-detail.field.status")}
              value={statusValue}
              onChange={(next) =>
                setStatusValue(next as OrganizationUnitStatusEnum)
              }
              data={statusSelectOptions}
              data-testid="unit-detail-status-select"
              disabled={upsert.isMutating}
              allowDeselect={false}
            />
          </ResponsiveGrid>

          <SettingsField
            label={i18n.t("admin.organization.unit-detail.field.parent")}
          >
            <Group>
              <Box flex={1} miw={0}>
                <OuPicker
                  value={parentUnitId}
                  displayValue={
                    selectedParent
                      ? `${selectedParent.name} · ${selectedParent.slug}`
                      : null
                  }
                  onChange={setParentUnitId}
                  placeholder={i18n.t(
                    "admin.organization.unit-detail.parent-placeholder",
                  )}
                  disabled={upsert.isMutating}
                  data-testid="unit-detail-parent-picker"
                />
              </Box>
              <Button
                type="button"
                variant="plain"
                disabled={parentUnitId === null || upsert.isMutating}
                onClick={() => setParentUnitId(null)}
              >
                {i18n.t("admin.organization.unit-detail.parent-root")}
              </Button>
            </Group>
          </SettingsField>

          <FactList>
            <Fact
              label={i18n.t("admin.organization.unit-detail.field.created")}
              value={formatDate(i18n, unit.createdAt)}
            />
            <Fact
              label={i18n.t("admin.organization.unit-detail.field.updated")}
              value={formatDate(i18n, unit.updatedAt)}
            />
          </FactList>

          {unit.description ? (
            <SettingsStatusText>{unit.description}</SettingsStatusText>
          ) : null}

          <SettingsStatusText>
            {i18n.t("admin.organization.unit-detail.audit-hint")}
          </SettingsStatusText>

          <SettingsToolbar justify="space-between">
            <StatusDot
              tone={dirty ? "warning" : "success"}
              label={
                dirty
                  ? i18n.t("admin.organization.unit-detail.dirty")
                  : i18n.t("admin.organization.unit-detail.clean")
              }
            />
            <SettingsToolbar>
              <Button
                type="button"
                variant="plain"
                disabled={!dirty || upsert.isMutating}
                onClick={reset}
                prefix={<RotateCcw aria-hidden="true" />}
              >
                {i18n.t("admin.actions.reset")}
              </Button>
              <Button
                type="button"
                variant="primary"
                data-testid="unit-detail-save-button"
                disabled={!dirty || !canSave || upsert.isMutating}
                onClick={saveMasterData}
                prefix={<Save aria-hidden="true" />}
              >
                {i18n.t("admin.actions.save")}
              </Button>
            </SettingsToolbar>
          </SettingsToolbar>
        </TabsContent>

        <TabsContent value="members" layout="stack">
          <SettingsToolbar justify="space-between">
            <SettingsSectionHeading level={4}>
              {i18n.t("admin.organization.unit-detail.members.title")}
            </SettingsSectionHeading>
            <SettingsListItemMeta>{members.length}</SettingsListItemMeta>
          </SettingsToolbar>
          <Stack component="section">
            <ResponsiveGrid cols={2}>
              <UserPicker
                label={i18n.t(
                  "admin.organization.unit-detail.members.add-label",
                )}
                mode="admin"
                excludeUnitId={unit.id}
                value={newMemberId}
                onChange={setNewMemberId}
                placeholder={i18n.t(
                  "admin.organization.unit-detail.members.add-placeholder",
                )}
                disabled={assignMember.isMutating}
                data-testid="unit-detail-add-member-picker"
              />
              <FormSelect
                label={i18n.t("admin.common.role")}
                allowDeselect={false}
                value={newMemberRole}
                onChange={(next) =>
                  setNewMemberRole(next as OrganizationUnitRoleEnum)
                }
                data={memberRoleSelectOptions}
                data-testid="unit-detail-add-member-role"
                disabled={assignMember.isMutating}
              />
            </ResponsiveGrid>
            <Group justify="flex-end">
              <Button
                type="button"
                variant="primary"
                disabled={!newMemberId || assignMember.isMutating}
                onClick={addMember}
                data-testid="unit-detail-add-member-button"
                prefix={<UserPlus aria-hidden="true" />}
              >
                {i18n.t("admin.organization.unit-detail.members.add")}
              </Button>
            </Group>
          </Stack>
          {members.length === 0 ? (
            <SettingsEmptyState
              title={i18n.t(
                "admin.organization.unit-detail.members.empty-title",
              )}
              description={i18n.t(
                "admin.organization.unit-detail.members.empty-hint",
              )}
            />
          ) : (
            <Table
              aria-label={i18n.t(
                "admin.organization.unit-detail.members.title",
              )}
              data-testid="unit-detail-members-list"
            >
              <TableHeader>
                <TableRow>
                  <TableHead>{i18n.t("admin.common.name")}</TableHead>
                  <TableHead>{i18n.t("admin.common.role")}</TableHead>
                  <TableHead>
                    {i18n.t("admin.organization.unit-detail.members.source")}
                  </TableHead>
                  <TableHead>{i18n.t("admin.common.actions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {members.map((member) => {
                  const displayName =
                    member.userName || member.userEmail || member.userId;
                  const email = member.userEmail || member.userId;
                  return (
                    <TableRow
                      key={member.userId}
                      data-testid={`unit-detail-member-row-${member.userId}`}
                    >
                      <TableCell>
                        <Group>
                          <Avatar
                            name={displayName || email}
                            url={member.userAvatarUrl}
                            colorfulFallback
                          />
                          <Stack>
                            <SettingsListItemTitle truncate>
                              {displayName}
                            </SettingsListItemTitle>
                            <SettingsListItemMeta truncate>
                              {email}
                            </SettingsListItemMeta>
                          </Stack>
                        </Group>
                      </TableCell>
                      <TableCell>
                        <FormSelect
                          allowDeselect={false}
                          aria-label={i18n.t("admin.common.role")}
                          value={member.role as OrganizationUnitRoleEnum}
                          onChange={(next) =>
                            saveMemberRole(
                              member.userId,
                              next as OrganizationUnitRoleEnum,
                            )
                          }
                          data={memberRoleSelectOptions}
                          data-testid={`unit-detail-member-role-${member.userId}`}
                          disabled={assignMember.isMutating}
                        />
                      </TableCell>
                      <TableCell>
                        <SettingsListItemMeta>
                          {String(member.source).toLowerCase()}
                        </SettingsListItemMeta>
                      </TableCell>
                      <TableCell>
                        <IconButton
                          type="button"
                          onClick={() => setRemoveMemberId(member.userId)}
                          data-testid={`unit-detail-member-remove-${member.userId}`}
                          icon={<UserMinus aria-hidden="true" />}
                          tooltip={i18n.t(
                            "admin.organization.unit-detail.members.remove",
                          )}
                          aria-label={i18n.t(
                            "admin.organization.unit-detail.members.remove",
                          )}
                          disabled={unassignMember.isMutating}
                        />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
          <AdminConfirmModal
            open={removeMemberId !== null}
            onOpenChange={(open) => {
              if (!open) setRemoveMemberId(null);
            }}
            title={i18n.t(
              "admin.organization.unit-detail.members.remove-title",
            )}
            description={i18n.t(
              "admin.organization.unit-detail.members.remove-description",
            )}
            cancelText={i18n.t("admin.actions.cancel")}
            confirmText={i18n.t("admin.actions.delete-confirm")}
            danger
            onConfirm={removeMember}
          />
        </TabsContent>

        <TabsContent value="workspaces" layout="stack">
          <SettingsToolbar justify="space-between">
            <SettingsSectionHeading level={4}>
              {i18n.t("admin.organization.unit-detail.workspaces.title")}
            </SettingsSectionHeading>
            <SettingsListItemMeta>{links.length}</SettingsListItemMeta>
          </SettingsToolbar>

          <FactList testId="unit-detail-workspace-quota-summary">
            <Fact
              label={i18n.t(
                "admin.organization.unit-detail.workspaces.summary.total",
              )}
              value={workspaceQuotaSummary.total}
            />
            <Fact
              label={i18n.t(
                "admin.organization.unit-detail.workspaces.summary.used",
              )}
              value={formatBytes(
                workspaceQuotaSummary.usedBytes,
                i18n.t("admin.state.unknown"),
                i18n.t("admin.organization.unit-detail.workspaces.unlimited"),
              )}
            />
          </FactList>

          <Stack component="section">
            <ResponsiveGrid cols={2}>
              <WorkspacePicker
                label={i18n.t(
                  "admin.organization.unit-detail.workspaces.add-workspace",
                )}
                value={newWorkspaceId}
                onChange={setNewWorkspaceId}
                excludeUnitId={unit.id}
                disabled={assignWorkspace.isMutating}
                data-testid="unit-detail-add-workspace-picker"
              />
              <FormSelect
                label={i18n.t(
                  "admin.organization.unit-detail.workspaces.relationship",
                )}
                value={newWorkspaceRelationship}
                onChange={(value) =>
                  setNewWorkspaceRelationship(
                    value as OrganizationUnitWorkspaceRelationshipEnum,
                  )
                }
                data={workspaceRelationshipSelectOptions}
                data-testid="unit-detail-add-workspace-relationship"
                disabled={assignWorkspace.isMutating}
                allowDeselect={false}
              />
            </ResponsiveGrid>
            <Group justify="flex-end">
              <Button
                type="button"
                variant="primary"
                disabled={!newWorkspaceId || assignWorkspace.isMutating}
                onClick={addWorkspace}
                data-testid="unit-detail-add-workspace-button"
                prefix={<Briefcase aria-hidden="true" />}
              >
                {i18n.t("admin.organization.unit-detail.workspaces.add")}
              </Button>
            </Group>
          </Stack>

          {links.length === 0 ? (
            <SettingsEmptyState
              title={i18n.t(
                "admin.organization.unit-detail.workspaces.empty-title",
              )}
              description={i18n.t(
                "admin.organization.unit-detail.workspaces.empty-hint",
              )}
            />
          ) : (
            <Table
              aria-label={i18n.t(
                "admin.organization.unit-detail.workspaces.title",
              )}
              data-testid="unit-detail-workspaces-list"
            >
              <TableHeader>
                <TableRow>
                  <TableHead>
                    {i18n.t("admin.organization.unit-detail.workspaces.title")}
                  </TableHead>
                  <TableHead>
                    {i18n.t(
                      "admin.organization.unit-detail.workspaces.relationship",
                    )}
                  </TableHead>
                  <TableHead>
                    {i18n.t(
                      "admin.organization.unit-detail.workspaces.storage",
                    )}
                  </TableHead>
                  <TableHead>{i18n.t("admin.common.actions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {links.map((link) => (
                  <TableRow
                    key={`${link.workspaceId}:${link.relationship}`}
                    data-testid={`unit-detail-workspace-row-${link.workspaceId}`}
                  >
                    <TableCell>
                      <Stack>
                        <SettingsListItemTitle truncate>
                          {link.workspaceName ?? link.workspaceId}
                        </SettingsListItemTitle>
                        <SettingsListItemMeta truncate>
                          {i18n.t(
                            "admin.organization.unit-detail.workspaces.owner",
                          )}
                          : {link.ownerEmail ?? link.ownerUserId ?? "-"}
                        </SettingsListItemMeta>
                      </Stack>
                    </TableCell>
                    <TableCell>
                      <FormSelect
                        allowDeselect={false}
                        value={link.relationship}
                        onChange={(value) =>
                          saveWorkspaceRelationship(
                            link,
                            value as OrganizationUnitWorkspaceRelationshipEnum,
                          )
                        }
                        data={workspaceRelationshipSelectOptions}
                        disabled={assignWorkspace.isMutating}
                        aria-label={i18n.t(
                          "admin.organization.unit-detail.workspaces.relationship",
                        )}
                        data-testid={`unit-detail-workspace-relationship-${link.workspaceId}`}
                      />
                    </TableCell>
                    <TableCell>
                      <SettingsListItemTitle>
                        {formatBytes(
                          link.storageUsedBytes,
                          i18n.t("admin.state.unknown"),
                          i18n.t(
                            "admin.organization.unit-detail.workspaces.unlimited",
                          ),
                        )}{" "}
                        /{" "}
                        {formatBytes(
                          link.effectiveQuotaBytes,
                          i18n.t("admin.state.unknown"),
                          i18n.t(
                            "admin.organization.unit-detail.workspaces.unlimited",
                          ),
                        )}
                      </SettingsListItemTitle>
                    </TableCell>
                    <TableCell>
                      <IconButton
                        type="button"
                        onClick={() => setRemoveWorkspaceLink(link)}
                        data-testid={`unit-detail-workspace-remove-${link.workspaceId}`}
                        aria-label={i18n.t("admin.actions.delete-confirm")}
                        tooltip={i18n.t("admin.actions.delete-confirm")}
                        icon={<UserMinus aria-hidden="true" />}
                        disabled={unassignWorkspace.isMutating}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          <AdminConfirmModal
            open={removeWorkspaceLink !== null}
            onOpenChange={(open) => {
              if (!open) setRemoveWorkspaceLink(null);
            }}
            title={i18n.t(
              "admin.organization.unit-detail.workspaces.remove-title",
            )}
            description={i18n.t(
              "admin.organization.unit-detail.workspaces.remove-description",
            )}
            cancelText={i18n.t("admin.actions.cancel")}
            confirmText={i18n.t("admin.actions.delete-confirm")}
            danger
            onConfirm={removeWorkspace}
          />
        </TabsContent>

        <TabsContent
          value="quota"
          layout="stack"
          data-testid="unit-detail-quota-panel"
        >
          <SettingsToolbar justify="space-between">
            <SettingsSectionHeading level={4}>
              {i18n.t("admin.organization.unit-detail.quota.title")}
            </SettingsSectionHeading>
          </SettingsToolbar>

          <FactList testId="unit-detail-quota-summary">
            <Fact
              label={i18n.t("admin.organization.unit-detail.quota.used")}
              value={`${formatBytes(
                unitQuotaSummary.usedBytes,
                i18n.t("admin.state.unknown"),
                i18n.t("admin.organization.unit-detail.workspaces.unlimited"),
              )} / ${formatBytes(
                unitQuotaSummary.effectiveQuotaBytes,
                i18n.t("admin.state.unknown"),
                i18n.t("admin.organization.unit-detail.workspaces.unlimited"),
              )}`}
            />
            <Fact
              label={i18n.t(
                "admin.organization.unit-detail.quota.members-limit",
              )}
              value={`${members.length} / ${unitQuotaSummary.maxMembers ?? "-"}`}
            />
          </FactList>

          <Stack component="section">
            <ResponsiveGrid cols={{ base: 1, sm: 2 }}>
              <SettingsField
                labelFor={`${fieldId}-quota-member-limit`}
                label={i18n.t(
                  "admin.organization.unit-detail.quota.members-limit",
                )}
              >
                <Input
                  id={`${fieldId}-quota-member-limit`}
                  type="number"
                  min={1}
                  inputMode="numeric"
                  value={quotaMemberLimit}
                  onChange={setQuotaMemberLimit}
                  mono
                  data-testid="unit-detail-quota-member-limit"
                />
              </SettingsField>
            </ResponsiveGrid>

            <SettingsToolbar justify="flex-end">
              <Button
                type="button"
                variant="plain"
                disabled={!quotaDirty || upsert.isMutating}
                onClick={() =>
                  setQuotaMemberLimit(String(baseline?.maxMembers))
                }
                prefix={<RotateCcw aria-hidden />}
              >
                {i18n.t("admin.actions.reset")}
              </Button>
              <Button
                type="button"
                variant="primary"
                onClick={saveUnitQuotaSettings}
                data-testid="unit-detail-quota-save"
                disabled={!quotaDirty || upsert.isMutating}
                prefix={<Save aria-hidden="true" />}
              >
                {i18n.t("admin.actions.save")}
              </Button>
            </SettingsToolbar>
          </Stack>
        </TabsContent>

        <TabsContent
          value="audit"
          layout="stack"
          data-testid="unit-detail-audit-panel"
        >
          <SettingsToolbar justify="space-between">
            <Stack>
              <SettingsSectionHeading level={4}>
                {i18n.t("admin.organization.unit-detail.audit.title")}
              </SettingsSectionHeading>
              <SettingsListItemMeta>
                {i18n.t("admin.organization.unit-detail.audit.hint")}
              </SettingsListItemMeta>
            </Stack>
            <SettingsToolbar justify="flex-end">
              <InlineLink
                href={auditHref}
                prefix={<ExternalLink aria-hidden />}
              >
                {i18n.t("admin.organization.unit-detail.audit.open-full")}
              </InlineLink>
              <SettingsListItemMeta>{auditTotalCount}</SettingsListItemMeta>
            </SettingsToolbar>
          </SettingsToolbar>

          {auditEntries.length === 0 ? (
            <SettingsEmptyState
              title={i18n.t("admin.organization.unit-detail.audit.empty-title")}
              description={i18n.t(
                "admin.organization.unit-detail.audit.empty-hint",
              )}
            />
          ) : (
            <ResponsiveGrid cols={{ base: 1, lg: 2 }}>
              <SurfaceList
                label={i18n.t("admin.organization.unit-detail.audit.title")}
                data-testid="unit-detail-audit-list"
              >
                {auditEntries.map((entry) => (
                  <SelectableCardRow
                    key={entry.id}
                    onClick={() => setSelectedAuditEntry(entry)}
                    data-testid={`unit-detail-audit-row-${entry.id}`}
                  >
                    <SettingsToolbar justify="space-between">
                      <SettingsListItemTitle truncate>
                        {eventLabel(entry.eventKey, i18n.t)}
                      </SettingsListItemTitle>
                      <SettingsListItemMeta>
                        {formatDate(i18n, entry.createdAt)}
                      </SettingsListItemMeta>
                    </SettingsToolbar>
                    <Stack>
                      <SettingsListItemMeta truncate>
                        {i18n.t("admin.organization.unit-detail.audit.actor")}:{" "}
                        {entry.actor?.label ?? "-"}
                      </SettingsListItemMeta>
                      <SettingsListItemMeta truncate>
                        {i18n.t("admin.organization.unit-detail.audit.target")}:{" "}
                        {entry.target?.label ?? entry.target?.id ?? "-"}
                      </SettingsListItemMeta>
                    </Stack>
                  </SelectableCardRow>
                ))}
              </SurfaceList>

              {selectedAuditEntry ? (
                <Stack
                  component="section"
                  data-testid="unit-detail-audit-drawer"
                >
                  <SettingsToolbar justify="space-between">
                    <Stack>
                      <SettingsListItemMeta>
                        {i18n.t(
                          "admin.organization.unit-detail.audit.drawer-title",
                        )}
                      </SettingsListItemMeta>
                      <SettingsListItemTitle truncate>
                        {eventLabel(selectedAuditEntry.eventKey, i18n.t)}
                      </SettingsListItemTitle>
                    </Stack>
                    <Button
                      type="button"
                      variant="plain"
                      onClick={() => setSelectedAuditEntry(null)}
                    >
                      {i18n.t("admin.actions.close")}
                    </Button>
                  </SettingsToolbar>
                  <Textarea
                    value={auditEntryJson(selectedAuditEntry)}
                    onChange={() => undefined}
                    readOnly
                    mono
                    rows={14}
                  />
                </Stack>
              ) : (
                <SettingsEmptyState
                  title={i18n.t(
                    "admin.organization.unit-detail.audit.drawer-empty",
                  )}
                />
              )}
            </ResponsiveGrid>
          )}
        </TabsContent>

        <TabsContent
          value="settings"
          layout="stack"
          data-testid="unit-detail-settings-panel"
        >
          <Stack>
            <SettingsSectionHeading level={4}>
              {i18n.t("admin.common.danger-zone")}
            </SettingsSectionHeading>
          </Stack>

          <SettingsToolbar justify="space-between">
            <Stack>
              <SettingsListItemTitle>
                {i18n.t("admin.organization.unit-detail.settings.title")}
              </SettingsListItemTitle>
              <SettingsListItemMeta>
                {i18n.t("admin.organization.unit-detail.settings.hint")}
              </SettingsListItemMeta>
            </Stack>
            <Button
              type="button"
              variant="secondary"
              prefix={<RefreshCw aria-hidden="true" />}
              disabled={deletionPreviewLoading}
              onClick={() => {
                if (!deletionPreviewEnabled) {
                  setDeletionPreviewEnabled(true);
                  return;
                }
                void mutateDeletionPreview?.();
              }}
              data-testid="unit-detail-deletion-preview-button"
            >
              {i18n.t("admin.actions.refresh")}
            </Button>
          </SettingsToolbar>

          {deletionPreview ? (
            <>
              <SettingsNotice
                tone={
                  unit.status === OrganizationUnitStatusEnum.Active
                    ? "neutral"
                    : deletionPreview.deletable
                      ? "success"
                      : "warning"
                }
              >
                {unit.status === OrganizationUnitStatusEnum.Active
                  ? i18n.t(
                      "admin.organization.unit-detail.deletion.active-hint",
                    )
                  : deletionPreview.deletable
                    ? i18n.t("admin.organization.unit-detail.deletion.ready")
                    : i18n.t("admin.organization.unit-detail.deletion.blocked")}
              </SettingsNotice>

              {deletionPreview.blockers.length > 0 ? (
                <SurfaceList
                  label={i18n.t(
                    "admin.organization.unit-detail.deletion.blocked",
                  )}
                >
                  {deletionPreview.blockers.map((blocker) => (
                    <SurfaceListItem key={blocker.code} density="compact">
                      <SettingsToolbar justify="space-between">
                        <SettingsListItemTitle>
                          {deletionBlockerLabel(i18n, blocker.code)}
                        </SettingsListItemTitle>
                        <Badge tone="warning">{blocker.count}</Badge>
                      </SettingsToolbar>
                    </SurfaceListItem>
                  ))}
                </SurfaceList>
              ) : null}

              <SettingsToolbar justify="space-between">
                <SettingsStatusText>
                  {i18n.t(
                    "admin.organization.unit-detail.deletion.irreversible",
                  )}
                </SettingsStatusText>
                <Button
                  type="button"
                  variant="error"
                  prefix={<Trash2 aria-hidden="true" />}
                  disabled={!deletionPreview.deletable || deleteUnit.isMutating}
                  onClick={() => setDeleteConfirmOpen(true)}
                  data-testid="unit-detail-delete-button"
                >
                  {i18n.t("admin.actions.delete")}
                </Button>
              </SettingsToolbar>
            </>
          ) : (
            <SettingsNotice tone="neutral">
              {unit.status === OrganizationUnitStatusEnum.Active
                ? i18n.t("admin.organization.unit-detail.deletion.active-hint")
                : i18n.t("admin.organization.unit-detail.deletion.load-hint")}
            </SettingsNotice>
          )}
        </TabsContent>
      </Tabs>
      <AdminTypeConfirmModal
        open={deleteConfirmOpen}
        onOpenChange={setDeleteConfirmOpen}
        title={i18n.t("admin.organization.unit-detail.deletion.confirm-title")}
        description={i18n.t(
          "admin.organization.unit-detail.deletion.confirm-description",
          { name: unit.name },
        )}
        targetText={unit.name}
        confirmText={i18n.t("admin.actions.delete-confirm")}
        onConfirm={confirmPermanentDelete}
      />
    </Stack>
  );
}
