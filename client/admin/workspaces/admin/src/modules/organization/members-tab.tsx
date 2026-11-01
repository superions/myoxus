// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Admin role primitive — Organization members tab.
 *
 * This tab migrates the account directory into the Organization domain while
 * preserving the important domain invariant: Admin is the only global user
 * capability edited here. Manager status is derived from OU memberships with
 * role `manager`; the UI never exposes a standalone Manager toggle.
 */
import { FeatureType, type ListUsersQuery } from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import {
  AtSign,
  CloseIcon,
  CopyIcon,
  ExternalLink,
  SearchIcon,
} from "@myoxus/icons/react";
import { ROUTES } from "@myoxus/routes";
import {
  Avatar,
  Button,
  DialogFooterActions,
  Divider,
  FormSelect,
  Group,
  InlineLink,
  Input,
  IconButton,
  NavigationLink,
  notify,
  SettingsEmptyState,
  SettingsNotice,
  SettingsSkeleton,
  SettingsCollectionToolbar,
  SettingsDetailHeader,
  SettingsListItemMeta,
  SettingsMasterDetailLayout,
  SettingsHeadingGroup,
  SettingsSectionHeading,
  SettingsSectionDescription,
  SettingsStatusText,
  Stack,
  StatusDot,
  SurfaceList,
  SurfaceListItem,
  SurfaceListItemMain,
  SurfaceListText,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@myoxus/ui-facade";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { eventLabel } from "../audit-log/audit-labels";
import { AdminConfirmModal } from "../../components/shared/admin-confirm-modal";
import {
  useOrganizationUnitsQuery,
  useOrganizationUsersQuery,
  useUserAuditLogQuery,
  useUserOrganizationMembershipsQuery,
} from "./api";
import {
  useDeleteUser,
  useDisableUser,
  useEnableUser,
  useResetUserPassword,
  useSetUserAdmin,
  useUpdateUser,
} from "./use-user-management";

export type OrganizationMember = ListUsersQuery["admin"]["users"][number];
type Membership = ReturnType<
  typeof useUserOrganizationMembershipsQuery
>["memberships"][number];
type AuditEntry = ReturnType<typeof useUserAuditLogQuery>["entries"][number];
type FeatureFilter = "all" | "admin" | "manager" | "disabled";
type DrawerTab = "profile" | "capabilities" | "memberships" | "activity";
type StatusTone = "neutral" | "success" | "warning" | "error" | "info";

type MembershipSummary = {
  isManager: boolean;
  unitIds: string[];
};

const ROLE_TONE: Record<string, StatusTone> = {
  reader: "neutral",
  member: "info",
  manager: "success",
};

function displayName(user: OrganizationMember): string {
  return user.name?.trim() || user.email;
}

function hasAdmin(user: OrganizationMember): boolean {
  return user.features.includes(FeatureType.Admin);
}

function hasManagerFeature(user: OrganizationMember): boolean {
  return user.features.includes(FeatureType.Manager);
}

function selectedFeatures(filter: FeatureFilter): FeatureType[] {
  if (filter === "admin") return [FeatureType.Admin];
  if (filter === "manager") return [FeatureType.Manager];
  return [];
}

export function MembersTab({
  onOpenUnit,
}: {
  onOpenUnit?: (unitId: string) => void;
}) {
  const i18n = useI18n();
  const unitsQuery = useOrganizationUnitsQuery();
  const { units } = unitsQuery;
  const [keyword, setKeyword] = useState("");
  const [featureFilter, setFeatureFilter] = useState<FeatureFilter>("all");
  const [unitFilter, setUnitFilter] = useState("all");
  const usersQuery = useOrganizationUsersQuery({
    keyword,
    features: selectedFeatures(featureFilter),
  });
  const { users, mutate } = usersQuery;
  const queryError = usersQuery.error ?? unitsQuery.error;
  const queryLoading = usersQuery.isLoading || unitsQuery.isLoading;
  const queryValidating = usersQuery.isValidating || unitsQuery.isValidating;
  const refresh = async () => {
    // Retry is a read; keep the selected profile and its unsaved draft mounted.
    await usersQuery.mutate(undefined, { throwOnError: false });
    await unitsQuery.mutate(undefined, { throwOnError: false });
  };
  const [selectedUser, setSelectedUser] = useState<OrganizationMember | null>(
    null,
  );
  const [detailDirty, setDetailDirty] = useState(false);
  const [detailBusy, setDetailBusy] = useState(false);
  const [pendingUser, setPendingUser] = useState<
    OrganizationMember | null | undefined
  >();
  const currentUser = selectedUser
    ? (users.find((user) => user.id === selectedUser.id) ?? selectedUser)
    : null;
  const selectUser = (user: OrganizationMember | null) => {
    if (detailBusy || user?.id === selectedUser?.id) return;
    if (detailDirty) setPendingUser(user);
    else setSelectedUser(user);
  };
  const [summaries, setSummaries] = useState<Record<string, MembershipSummary>>(
    {},
  );

  const visibleUsers = useMemo(
    () =>
      users.filter((user) => {
        if (featureFilter === "disabled" && !user.disabled) return false;
        const summary = summaries[user.id];
        if (
          featureFilter === "manager" &&
          !(summary?.isManager ?? hasManagerFeature(user))
        ) {
          return false;
        }
        if (unitFilter !== "all" && !summary?.unitIds.includes(unitFilter)) {
          return false;
        }
        return true;
      }),
    [featureFilter, summaries, unitFilter, users],
  );

  const handleUserDiagnostics = useCallback(
    (userId: string, memberships: Membership[]) => {
      const next: MembershipSummary = {
        isManager: memberships.some(
          (m: Membership) => m.role.toLowerCase() === "manager",
        ),
        unitIds: memberships.map((m: Membership) => m.unitId),
      };
      setSummaries((prev) => {
        const current = prev[userId];
        if (
          current &&
          current.isManager === next.isManager &&
          current.unitIds.join(",") === next.unitIds.join(",")
        ) {
          return prev;
        }
        return { ...prev, [userId]: next };
      });
    },
    [],
  );

  return (
    <Stack>
      <SettingsCollectionToolbar
        search={
          <Input
            id="organization-members-search"
            aria-label={i18n.t("admin.actions.search")}
            preFix={<SearchIcon aria-hidden />}
            value={keyword}
            onChange={setKeyword}
            placeholder={i18n.t("admin.actions.search-placeholder")}
          />
        }
        filters={
          <Group>
            <FormSelect
              aria-label={i18n.t("admin.organization.members.filter.feature")}
              value={featureFilter}
              onChange={(value) => setFeatureFilter(value as FeatureFilter)}
              data-testid="organization-members-feature-filter"
              data={[
                {
                  value: "all",
                  label: i18n.t(
                    "admin.organization.members.filter.feature-all",
                  ),
                },
                {
                  value: "admin",
                  label: i18n.t(
                    "admin.organization.members.filter.feature-admin",
                  ),
                },
                {
                  value: "manager",
                  label: i18n.t(
                    "admin.organization.members.filter.feature-manager",
                  ),
                },
                {
                  value: "disabled",
                  label: i18n.t(
                    "admin.organization.members.filter.feature-disabled",
                  ),
                },
              ]}
            />
            <FormSelect
              aria-label={i18n.t("admin.organization.members.filter.unit")}
              disabled={Boolean(unitsQuery.error || unitsQuery.isLoading)}
              value={unitFilter}
              onChange={setUnitFilter}
              data-testid="organization-members-unit-filter"
              data={[
                {
                  value: "all",
                  label: i18n.t("admin.organization.members.filter.unit-all"),
                },
                ...units.map((unit) => ({
                  value: unit.id,
                  label: unit.name,
                })),
              ]}
            />
          </Group>
        }
        actions={
          keyword || featureFilter !== "all" || unitFilter !== "all" ? (
            <IconButton
              icon={<CloseIcon aria-hidden />}
              aria-label={i18n.t("admin.actions.reset")}
              tooltip={i18n.t("admin.actions.reset")}
              onClick={() => {
                setKeyword("");
                setFeatureFilter("all");
                setUnitFilter("all");
              }}
            />
          ) : undefined
        }
      />
      <Divider />
      <SettingsMasterDetailLayout
        detail={
          currentUser ? (
            <MemberDrawer
              key={currentUser.id}
              user={currentUser}
              onClose={() => selectUser(null)}
              onDeleted={() => {
                // A confirmed commit removes this selection even if the list
                // revalidation is delayed; no draft remains to discard.
                setSelectedUser(null);
                setPendingUser(undefined);
                setDetailDirty(false);
                setDetailBusy(false);
              }}
              onDirtyChange={setDetailDirty}
              onBusyChange={setDetailBusy}
              onOpenUnit={onOpenUnit}
              onChanged={async () => {
                await mutate(undefined, { throwOnError: false });
              }}
            />
          ) : undefined
        }
        detailOpen={Boolean(selectedUser)}
        detailPriority="detail"
      >
        {queryError ? (
          <SettingsNotice
            tone="error"
            title={i18n.t("com.myoxus.settings.common.load-error")}
          >
            {queryError.message}
            <Group>
              <Button disabled={queryValidating} onClick={() => void refresh()}>
                {i18n.t("admin.error.retry")}
              </Button>
            </Group>
          </SettingsNotice>
        ) : queryLoading ? (
          <SettingsSkeleton />
        ) : visibleUsers.length === 0 ? (
          <SettingsEmptyState
            title={i18n.t("admin.organization.members.empty.title")}
            description={i18n.t("admin.organization.members.empty.hint")}
          />
        ) : (
          <SurfaceList label={i18n.t("admin.organization.tab.members")}>
            {visibleUsers.map((user) => (
              <MemberRow
                key={user.id}
                user={user}
                active={selectedUser?.id === user.id}
                onSelect={selectUser}
                onDiagnostics={handleUserDiagnostics}
              />
            ))}
          </SurfaceList>
        )}
      </SettingsMasterDetailLayout>
      <AdminConfirmModal
        open={pendingUser !== undefined}
        onOpenChange={(open) => {
          if (!open) setPendingUser(undefined);
        }}
        title={i18n.t("admin.unsaved.discard-title")}
        description={i18n.t("admin.unsaved.discard-description")}
        confirmText={i18n.t("admin.common.discard-changes")}
        onConfirm={() => {
          setDetailDirty(false);
          setSelectedUser(pendingUser ?? null);
          setPendingUser(undefined);
        }}
        onCancel={() => setPendingUser(undefined)}
      />
    </Stack>
  );
}

function MemberRow({
  user,
  active,
  onSelect,
  onDiagnostics,
}: {
  user: OrganizationMember;
  active: boolean;
  onSelect: (user: OrganizationMember) => void;
  onDiagnostics: (userId: string, memberships: Membership[]) => void;
}) {
  const i18n = useI18n();
  const diagnosticsQueryConfig = useMemo(
    () => ({
      suspense: false,
      shouldRetryOnError: false,
      revalidateOnFocus: false,
    }),
    [],
  );
  const { memberships, error, isLoading } = useUserOrganizationMembershipsQuery(
    user.id,
    diagnosticsQueryConfig,
  );
  const ready = !error && !isLoading;
  const isManager =
    ready &&
    memberships.some((m: Membership) => m.role.toLowerCase() === "manager");

  useEffect(() => {
    if (ready) onDiagnostics(user.id, memberships);
  }, [memberships, onDiagnostics, user.id, ready]);

  return (
    <NavigationLink
      component="button"
      data-testid={`organization-member-row-${user.id}`}
      type="button"
      onClick={() => onSelect(user)}
      active={active}
      aria-pressed={active}
      label={displayName(user)}
      leftSection={<Avatar name={displayName(user)} url={user.avatarUrl} />}
      description={
        <>
          {user.email}
          <Group>
            {hasAdmin(user) && (
              <StatusDot
                tone="warning"
                label={i18n.t("admin.organization.members.badge.admin")}
              />
            )}
            {isManager && (
              <StatusDot
                tone="success"
                label={i18n.t("admin.organization.members.badge.manager")}
              />
            )}
            {user.disabled && (
              <StatusDot
                tone="error"
                label={i18n.t("admin.organization.members.badge.disabled")}
              />
            )}
            {!user.hasPassword && (
              <StatusDot
                tone="info"
                label={i18n.t("admin.organization.members.badge.magic-link")}
              />
            )}
          </Group>
        </>
      }
      rightSection={
        <SettingsListItemMeta tone="active">
          {ready ? memberships.length : "—"}{" "}
          {i18n.t("admin.organization.members.memberships.short")}
        </SettingsListItemMeta>
      }
    />
  );
}

function MemberDrawer({
  user,
  onClose,
  onDeleted,
  onOpenUnit,
  onChanged,
  onDirtyChange,
  onBusyChange,
}: {
  user: OrganizationMember;
  onClose: () => void;
  onDeleted: () => void;
  onOpenUnit?: (unitId: string) => void;
  onChanged: () => Promise<void>;
  onDirtyChange: (dirty: boolean) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const i18n = useI18n();
  const [tab, setTab] = useState<DrawerTab>("profile");

  const tabs: DrawerTab[] = [
    "profile",
    "capabilities",
    "memberships",
    "activity",
  ];

  return (
    <Stack data-testid="organization-member-drawer">
      <SettingsDetailHeader
        title={displayName(user)}
        description={user.email}
        headingLevel={2}
        actions={
          <IconButton
            icon={<CloseIcon aria-hidden />}
            aria-label={i18n.t("admin.actions.close")}
            tooltip={i18n.t("admin.actions.close")}
            onClick={onClose}
          />
        }
      />
      <Tabs
        value={tab}
        onChange={(value) => {
          if (value) setTab(value as DrawerTab);
        }}
        layout="embedded"
        variant="default"
      >
        <TabsList variant="panel">
          {tabs.map((value) => (
            <TabsTrigger
              key={value}
              value={value}
              variant="panel"
              data-testid={`organization-member-drawer-tab-${value}`}
            >
              {i18n.t(
                `admin.organization.members.drawer.tab.${value}` as never,
              )}
            </TabsTrigger>
          ))}
        </TabsList>
        {/* Keep the owner's profile draft and one-time link across detail tabs. */}
        <TabsContent value="profile" layout="stack" forceMount>
          <ProfilePane
            user={user}
            onChanged={onChanged}
            onDeleted={onDeleted}
            onDirtyChange={onDirtyChange}
            onBusyChange={onBusyChange}
          />
        </TabsContent>
        <TabsContent value="capabilities" layout="stack">
          <CapabilitiesPane user={user} onChanged={onChanged} />
        </TabsContent>
        <TabsContent value="memberships" layout="stack">
          <MembershipsPane user={user} onOpenUnit={onOpenUnit} />
        </TabsContent>
        <TabsContent value="activity" layout="stack">
          <ActivityPane user={user} />
        </TabsContent>
      </Tabs>
    </Stack>
  );
}

function ProfilePane({
  user,
  onChanged,
  onDeleted,
  onDirtyChange,
  onBusyChange,
}: {
  user: OrganizationMember;
  onChanged: () => Promise<void>;
  onDeleted: () => void;
  onDirtyChange: (dirty: boolean) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const i18n = useI18n();
  const { update, updating } = useUpdateUser();
  const { deleteUser, deleting } = useDeleteUser();
  const disableUser = useDisableUser();
  const enableUser = useEnableUser();
  const { resetPasswordLink, onResetPassword } = useResetUserPassword();
  const [name, setName] = useState(user.name ?? "");
  const [email, setEmail] = useState(user.email);
  const [baseline, setBaseline] = useState({
    name: user.name ?? "",
    email: user.email,
  });
  const [deleteOpen, setDeleteOpen] = useState(false);
  const serverProfile = useRef({ name: user.name ?? "", email: user.email });
  const busy = updating || deleting;
  const dirty = name !== baseline.name || email !== baseline.email;

  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  useEffect(() => onBusyChange(busy), [busy, onBusyChange]);

  useEffect(() => {
    // React Activity reactivates effects on tab return; only new server data
    // may replace the draft, not the reactivation itself.
    if (
      serverProfile.current.name === (user.name ?? "") &&
      serverProfile.current.email === user.email
    )
      return;
    if (dirty) return;
    serverProfile.current = { name: user.name ?? "", email: user.email };
    setName(user.name ?? "");
    setEmail(user.email);
    setBaseline({ name: user.name ?? "", email: user.email });
  }, [dirty, user.email, user.name]);

  const save = useCallback(async () => {
    if (await update({ userId: user.id, name, email })) {
      setBaseline({ name, email });
      await onChanged();
    }
  }, [email, name, onChanged, update, user.id]);

  const reset = useCallback(async () => {
    await onResetPassword(user.id);
  }, [onResetPassword, user.id]);

  const copyResetLink = useCallback(async () => {
    await navigator.clipboard.writeText(resetPasswordLink);
    notify.success({
      title: i18n.t("admin.organization.members.action.copy-link-success"),
    });
  }, [i18n, resetPasswordLink]);

  const disabledText = user.disabled
    ? i18n.t("admin.organization.members.action.enable")
    : i18n.t("admin.organization.members.action.disable");

  return (
    <Stack>
      <Stack>
        <Input
          label={i18n.t("admin.organization.members.profile.name")}
          value={name}
          onChange={setName}
          disabled={busy}
        />
        <Input
          label={i18n.t("admin.organization.members.profile.email")}
          type="email"
          value={email}
          onChange={setEmail}
          disabled={busy}
        />
        <Group>
          <StatusDot
            tone={user.emailVerified ? "success" : "warning"}
            label={
              user.emailVerified
                ? i18n.t("admin.organization.members.profile.email-verified")
                : i18n.t("admin.organization.members.profile.email-unverified")
            }
          />
          <StatusDot
            tone={user.hasPassword ? "success" : "info"}
            label={
              user.hasPassword
                ? i18n.t("admin.organization.members.profile.password-set")
                : i18n.t("admin.organization.members.profile.password-missing")
            }
          />
        </Group>
      </Stack>

      <DialogFooterActions>
        <Button
          variant="secondary"
          disabled={!dirty || busy}
          onClick={() => {
            setName(baseline.name);
            setEmail(baseline.email);
          }}
        >
          {i18n.t("admin.common.discard-changes")}
        </Button>
        <Button
          disabled={!dirty || busy}
          loading={updating}
          onClick={() => void save()}
        >
          {i18n.t("admin.actions.save")}
        </Button>
      </DialogFooterActions>

      <Divider />
      <SettingsSectionHeading level={3}>
        {i18n.t("admin.common.actions")}
      </SettingsSectionHeading>
      <Group>
        <Button
          variant="secondary"
          disabled={busy}
          onClick={() => void reset()}
        >
          {i18n.t("admin.organization.members.action.reset-password")}
        </Button>
        <Button
          variant="secondary"
          disabled={busy}
          onClick={() =>
            user.disabled
              ? enableUser(user.id, () => void onChanged())
              : disableUser(user.id, () => void onChanged())
          }
        >
          {disabledText}
        </Button>
      </Group>

      {resetPasswordLink && (
        <Stack>
          <SettingsListItemMeta>
            {i18n.t("admin.organization.members.action.password-reset-link")}
          </SettingsListItemMeta>
          <Input
            value={resetPasswordLink}
            readOnly
            aria-label={i18n.t(
              "admin.organization.members.action.password-reset-link",
            )}
          />
          <IconButton
            icon={<CopyIcon aria-hidden />}
            aria-label={i18n.t("com.myoxus.comment.copy-link")}
            tooltip={i18n.t("com.myoxus.comment.copy-link")}
            onClick={() => void copyResetLink()}
          />
        </Stack>
      )}
      <Divider />
      <Group justify="space-between">
        <SettingsStatusText>
          {i18n.t("admin.organization.members.action.delete-prompt")}
        </SettingsStatusText>
        <Button
          variant="error"
          disabled={busy}
          onClick={() => setDeleteOpen(true)}
        >
          {i18n.t("admin.actions.delete")}
        </Button>
      </Group>
      <AdminConfirmModal
        open={deleteOpen}
        onOpenChange={(open) => {
          if (!deleting) setDeleteOpen(open);
        }}
        confirmButtonOptions={{ loading: deleting }}
        cancelButtonOptions={{ disabled: deleting }}
        title={i18n.t("admin.actions.delete-confirm")}
        description={i18n.t("admin.organization.members.action.delete-prompt")}
        confirmText={i18n.t("admin.actions.delete")}
        danger
        onConfirm={() =>
          deleteUser(user.id, () => {
            setDeleteOpen(false);
            onDeleted();
          })
        }
        onCancel={() => setDeleteOpen(false)}
      />
    </Stack>
  );
}

function CapabilitiesPane({
  user,
  onChanged,
}: {
  user: OrganizationMember;
  onChanged: () => Promise<void>;
}) {
  const i18n = useI18n();
  const setUserAdmin = useSetUserAdmin();
  const admin = hasAdmin(user);

  return (
    <Stack>
      <SettingsHeadingGroup>
        <SettingsSectionHeading level={3}>
          {i18n.t("admin.organization.members.capabilities.admin.title")}
        </SettingsSectionHeading>
        <SettingsSectionDescription>
          {i18n.t("admin.organization.members.capabilities.admin.description")}
        </SettingsSectionDescription>
      </SettingsHeadingGroup>
      <Group>
        <Button
          variant={admin ? "secondary" : "primary"}
          onClick={async () => {
            await setUserAdmin(user.id, !admin);
            await onChanged();
          }}
        >
          {admin
            ? i18n.t("admin.organization.members.action.remove-admin")
            : i18n.t("admin.organization.members.action.make-admin")}
        </Button>
      </Group>
      <SettingsListItemMeta>
        {i18n.t("admin.organization.members.capabilities.manager-note")}
      </SettingsListItemMeta>
    </Stack>
  );
}

function MembershipsPane({
  user,
  onOpenUnit,
}: {
  user: OrganizationMember;
  onOpenUnit?: (unitId: string) => void;
}) {
  const i18n = useI18n();
  const { memberships, error, isLoading, isValidating, mutate } =
    useUserOrganizationMembershipsQuery(user.id);

  if (error) {
    return (
      <SettingsNotice
        tone="error"
        title={i18n.t("com.myoxus.settings.common.load-error")}
      >
        {error.message}
        <Group>
          <Button
            disabled={isValidating}
            onClick={() => void mutate(undefined, { throwOnError: false })}
          >
            {i18n.t("admin.error.retry")}
          </Button>
        </Group>
      </SettingsNotice>
    );
  }
  if (isLoading) return <SettingsSkeleton />;

  if (memberships.length === 0) {
    return (
      <SettingsEmptyState
        title={i18n.t("admin.organization.members.memberships.empty.title")}
        description={i18n.t(
          "admin.organization.members.memberships.empty.hint",
        )}
      />
    );
  }

  return (
    <SurfaceList
      label={i18n.t("admin.organization.members.drawer.tab.memberships")}
    >
      {memberships.map((membership: Membership) => (
        <NavigationLink
          key={`${membership.unitId}-${membership.role}`}
          component="button"
          data-testid={`organization-member-membership-${membership.unitId}`}
          type="button"
          onClick={() => onOpenUnit?.(membership.unitId)}
          disabled={!onOpenUnit}
          label={membership.unitName}
          description={`${membership.unitSlug} · ${membership.source}`}
          rightSection={
            <StatusDot
              tone={ROLE_TONE[membership.role.toLowerCase()] ?? "neutral"}
              label={membership.role}
            />
          }
        />
      ))}
    </SurfaceList>
  );
}

function ActivityPane({ user }: { user: OrganizationMember }) {
  const i18n = useI18n();
  const { entries, error, isLoading, isValidating, mutate } =
    useUserAuditLogQuery(user.id);
  const auditHref = `${ROUTES.admin.auditLog}?actor_user_id=${encodeURIComponent(user.id)}`;

  if (error) {
    return (
      <SettingsNotice
        tone="error"
        title={i18n.t("com.myoxus.settings.common.load-error")}
      >
        {error.message}
        <Group>
          <Button
            disabled={isValidating}
            onClick={() => void mutate(undefined, { throwOnError: false })}
          >
            {i18n.t("admin.error.retry")}
          </Button>
        </Group>
      </SettingsNotice>
    );
  }
  if (isLoading) return <SettingsSkeleton />;

  if (entries.length === 0) {
    return (
      <Stack>
        <SettingsEmptyState
          title={i18n.t("admin.organization.members.activity.empty.title")}
          description={i18n.t("admin.organization.members.activity.empty.hint")}
        />
        <InlineLink href={auditHref} prefix={<ExternalLink aria-hidden />}>
          {i18n.t("admin.organization.members.activity.open-audit")}
        </InlineLink>
      </Stack>
    );
  }

  return (
    <Stack>
      <InlineLink href={auditHref} prefix={<ExternalLink aria-hidden />}>
        {i18n.t("admin.organization.members.activity.open-audit")}
      </InlineLink>
      <SurfaceList
        label={i18n.t("admin.organization.members.drawer.tab.activity")}
      >
        {entries.map((entry: AuditEntry) => (
          <SurfaceListItem
            key={entry.id}
            component="div"
            density="compact"
            layout="row"
          >
            <AtSign aria-hidden />
            <SurfaceListItemMain grow>
              <SurfaceListText kind="title">
                {eventLabel(entry.eventKey, i18n.t)}
              </SurfaceListText>
              <SurfaceListText kind="description">
                {new Intl.DateTimeFormat(i18n.language, {
                  dateStyle: "medium",
                  timeStyle: "short",
                }).format(new Date(entry.createdAt))}
              </SurfaceListText>
            </SurfaceListItemMain>
          </SurfaceListItem>
        ))}
      </SurfaceList>
    </Stack>
  );
}
