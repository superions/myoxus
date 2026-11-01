/**
 * Workspace Members section for the workspace detail panel.
 *
 * Features:
 * - Paginated table (8 per page) with Name, Email, Role, Status, Joined columns
 * - Debounced search field
 * - Remove button per row (not on owner/self row)
 * - Confirmation dialog for removal
 * - "Add Member" button that opens a dialog to search users and grant access
 *
 * All data is fetched via `adminWorkspaceQuery` using `memberSkip`, `memberTake`,
 * and `memberQuery` variables. Mutations use the admin workspace-member
 * surface so all workspace memberships use one authoritative model.
 */
import { adminToast as toast } from "@myoxus/admin/notifications";
import {
  adminAddWorkspaceMemberMutation,
  adminRemoveWorkspaceMemberMutation,
  adminUpdateWorkspaceMemberRoleMutation,
  adminWorkspaceQuery,
  listUsersQuery,
  Permission,
  WorkspaceMemberStatus,
} from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import { SearchIcon, UserMinusIcon, UserPlusIcon } from "@myoxus/icons/react";
import {
  Avatar,
  Badge,
  Button,
  Divider,
  Group,
  Input,
  IconButton,
  Modal,
  MyoxusSelect,
  Pagination,
  NavigationLink,
  SettingsEmptyState,
  SettingsListItemMeta,
  SettingsListItemTitle,
  SettingsSectionHeading,
  SettingsCollectionToolbar,
  SettingsStatusText,
  SettingsToolbar,
  Stack,
  SurfaceList,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@myoxus/ui-facade";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AdminConfirmModal } from "../../../components/shared/admin-confirm-modal";
import { useMutateQueryResource, useMutation } from "../../../use-mutation";
import { useQuery } from "../../../use-query";

const PAGE_SIZE = 8;

const WORKSPACE_ROLE_OPTIONS: readonly Permission[] = [
  Permission.Admin,
  Permission.Manager,
  Permission.Collaborator,
  Permission.Commenter,
  Permission.Reader,
];

function roleLabel(i18n: ReturnType<typeof useI18n>, role: Permission): string {
  return i18n.t(`admin.workspaces.members.role-option-${role}` as never);
}

// ---------------------------------------------------------------------------
// Role badge
// ---------------------------------------------------------------------------

const ROLE_BADGE_VARIANT: Record<
  Permission,
  "success" | "warning" | "error" | "neutral"
> = {
  [Permission.Owner]: "success",
  [Permission.Admin]: "success",
  [Permission.Manager]: "warning",
  [Permission.Collaborator]: "warning",
  [Permission.Commenter]: "neutral",
  [Permission.External]: "neutral",
  [Permission.Reader]: "neutral",
};

function RoleBadge({ role }: { role: Permission }) {
  const i18n = useI18n();
  return (
    <Badge tone={ROLE_BADGE_VARIANT[role] ?? "neutral"}>
      {roleLabel(i18n, role)}
    </Badge>
  );
}

// ---------------------------------------------------------------------------
// Status badge
// ---------------------------------------------------------------------------

const STATUS_BADGE_VARIANT: Record<
  WorkspaceMemberStatus,
  "success" | "warning" | "error" | "neutral"
> = {
  [WorkspaceMemberStatus.Accepted]: "success",
  [WorkspaceMemberStatus.Pending]: "warning",
  [WorkspaceMemberStatus.AllocatingSeat]: "warning",
  [WorkspaceMemberStatus.NeedMoreSeat]: "error",
  [WorkspaceMemberStatus.UnderReview]: "warning",
  [WorkspaceMemberStatus.Revoked]: "neutral",
};

function StatusBadge({ status }: { status: WorkspaceMemberStatus }) {
  const i18n = useI18n();
  const label: Record<WorkspaceMemberStatus, string> = {
    [WorkspaceMemberStatus.Accepted]: i18n.t(
      "admin.workspaces.members.status-active",
    ),
    [WorkspaceMemberStatus.Pending]: i18n.t(
      "admin.workspaces.members.status-pending",
    ),
    [WorkspaceMemberStatus.AllocatingSeat]: i18n.t(
      "admin.workspaces.members.status-allocating",
    ),
    [WorkspaceMemberStatus.NeedMoreSeat]: i18n.t(
      "admin.workspaces.members.status-no-seat",
    ),
    [WorkspaceMemberStatus.UnderReview]: i18n.t(
      "admin.workspaces.members.status-under-review",
    ),
    [WorkspaceMemberStatus.Revoked]: i18n.t(
      "admin.workspaces.members.status-revoked",
    ),
  };
  return (
    <Badge tone={STATUS_BADGE_VARIANT[status] ?? "neutral"}>
      {label[status] ?? status}
    </Badge>
  );
}

// ---------------------------------------------------------------------------
// Add Member dialog
// ---------------------------------------------------------------------------

interface AddMemberDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  existingMemberIds: Set<string>;
  onAdded: () => void;
}

function AddMemberDialog({
  open,
  onOpenChange,
  workspaceId,
  existingMemberIds,
  onAdded,
}: AddMemberDialogProps) {
  const i18n = useI18n();
  const [searchInput, setSearchInput] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [role, setRole] = useState<Permission>(Permission.Collaborator);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const roleOptions = useMemo(() => [...WORKSPACE_ROLE_OPTIONS], []);

  const { trigger: addMember, isMutating } = useMutation({
    mutation: adminAddWorkspaceMemberMutation,
  });
  const revalidate = useMutateQueryResource();

  useEffect(() => {
    if (!roleOptions.includes(role)) {
      setRole(Permission.Collaborator);
    }
  }, [role, roleOptions]);

  // Debounce search input
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setDebouncedSearch(searchInput.trim());
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [searchInput]);

  // Reset state when dialog closes
  useEffect(() => {
    if (!open) {
      setSearchInput("");
      setDebouncedSearch("");
      setSelectedUserId(null);
      setRole(Permission.Collaborator);
    }
  }, [open]);

  const { data: usersData } = useQuery({
    query: listUsersQuery,
    variables: { filter: { keyword: debouncedSearch || undefined, first: 10 } },
  });

  const users = usersData?.admin?.users ?? [];

  const handleAdd = useCallback(() => {
    if (!selectedUserId) return;
    addMember({ workspaceId, userId: selectedUserId, role })
      .then(async () => {
        toast.success(i18n.t("admin.workspaces.members.add-success"));
        await revalidate(
          adminWorkspaceQuery,
          (vars: { id?: string } | undefined) => vars?.id === workspaceId,
        );
        onAdded();
        onOpenChange(false);
      })
      .catch((e: Error) => {
        toast.error(
          i18n.t("admin.workspaces.members.add-failed", { message: e.message }),
        );
      });
  }, [
    addMember,
    workspaceId,
    selectedUserId,
    role,
    revalidate,
    onAdded,
    onOpenChange,
    i18n,
  ]);

  const selectedUser = users.find((u) => u.id === selectedUserId);

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={i18n.t("admin.workspaces.members.add-dialog-title")}
      description={i18n.t("admin.workspaces.members.add-dialog-description")}
    >
      <Stack data-testid="add-member-dialog">
        <Input
          label={i18n.t("admin.workspaces.members.add-search-placeholder")}
          placeholder={i18n.t(
            "admin.workspaces.members.add-search-placeholder",
          )}
          value={searchInput}
          onChange={(value) => {
            setSearchInput(value);
            setSelectedUserId(null);
          }}
          data-testid="add-member-search"
        />

        {/* User results */}
        {debouncedSearch && (
          <SurfaceList>
            {users.length === 0 ? (
              <SettingsEmptyState
                title={i18n.t("admin.workspaces.members.add-no-users")}
              />
            ) : (
              users.map((user) => {
                const alreadyMember = existingMemberIds.has(user.id);
                const isSelected = selectedUserId === user.id;
                return (
                  <NavigationLink
                    component="button"
                    type="button"
                    key={user.id}
                    disabled={alreadyMember}
                    onClick={() => setSelectedUserId(user.id)}
                    data-testid={`user-result-${user.id}`}
                    active={isSelected}
                    aria-pressed={isSelected}
                    label={user.name ?? user.email}
                    description={user.email}
                    leftSection={
                      <Avatar
                        name={user.name ?? user.email}
                        url={user.avatarUrl}
                      />
                    }
                    rightSection={
                      alreadyMember ? (
                        <Badge tone="neutral">
                          {i18n.t("admin.workspaces.members.already-member")}
                        </Badge>
                      ) : undefined
                    }
                  />
                );
              })
            )}
          </SurfaceList>
        )}

        {/* Role selector */}
        <MyoxusSelect
          label={i18n.t("admin.workspaces.members.add-role-label")}
          value={role}
          onChange={(value) => setRole(value as Permission)}
          data={roleOptions.map((option) => ({
            value: option,
            label: roleLabel(i18n, option),
          }))}
          data-testid="add-member-role-select"
        />

        {selectedUser && (
          <SettingsStatusText>
            {i18n.t("admin.workspaces.members.add-will-add", {
              name: selectedUser.name ?? selectedUser.email,
              role: roleLabel(i18n, role),
            })}
          </SettingsStatusText>
        )}
      </Stack>

      <SettingsToolbar justify="end">
        <Button
          type="button"
          variant="secondary"
          onClick={() => onOpenChange(false)}
        >
          {i18n.t("admin.common.cancel")}
        </Button>
        <Button
          type="button"
          variant="primary"
          disabled={!selectedUserId || isMutating}
          onClick={handleAdd}
          data-testid="add-member-confirm-btn"
        >
          {isMutating
            ? i18n.t("admin.workspaces.members.adding")
            : i18n.t("admin.workspaces.members.add")}
        </Button>
      </SettingsToolbar>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Main export: WorkspaceMembersSection
// ---------------------------------------------------------------------------

interface WorkspaceMembersSectionProps {
  workspaceId: string;
  ownerId: string | null;
}

export function WorkspaceMembersSection({
  workspaceId,
  ownerId,
}: WorkspaceMembersSectionProps) {
  const i18n = useI18n();
  const [page, setPage] = useState(0);
  const [searchInput, setSearchInput] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [removeTarget, setRemoveTarget] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [roleUpdatingUserId, setRoleUpdatingUserId] = useState<string | null>(
    null,
  );

  const { trigger: removeMember, isMutating: isRevoking } = useMutation({
    mutation: adminRemoveWorkspaceMemberMutation,
  });
  const { trigger: updateMemberRole } = useMutation({
    mutation: adminUpdateWorkspaceMemberRoleMutation,
  });
  const revalidate = useMutateQueryResource();
  const roleOptions = useMemo(() => [...WORKSPACE_ROLE_OPTIONS], []);

  // Debounce search input (300 ms)
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setDebouncedSearch(searchInput.trim());
      setPage(0);
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [searchInput]);

  const { data } = useQuery({
    query: adminWorkspaceQuery,
    variables: {
      id: workspaceId,
      memberSkip: page * PAGE_SIZE,
      memberTake: PAGE_SIZE,
      memberQuery: debouncedSearch || undefined,
    },
  });

  const workspace = data?.admin?.adminWorkspace;
  const members = useMemo(() => workspace?.members ?? [], [workspace?.members]);
  const totalCount = workspace?.memberCount ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  const existingMemberIds = useMemo(
    () => new Set(members.map((m) => m.id)),
    [members],
  );

  const handleRemoveConfirm = useCallback(() => {
    if (!removeTarget) return;
    removeMember({ workspaceId, userId: removeTarget.id })
      .then(async () => {
        toast.success(
          i18n.t("admin.workspaces.members.remove-success", {
            name: removeTarget.name,
          }),
        );
        setRemoveTarget(null);
        await revalidate(
          adminWorkspaceQuery,
          (vars: { id?: string } | undefined) => vars?.id === workspaceId,
        );
      })
      .catch((e: Error) => {
        toast.error(
          i18n.t("admin.workspaces.members.remove-failed", {
            message: e.message,
          }),
        );
      });
  }, [i18n, removeMember, removeTarget, revalidate, workspaceId]);

  const handleRoleChange = useCallback(
    (
      member: {
        id: string;
        name?: string | null;
        email: string;
        role: unknown;
      },
      nextRole: Permission,
    ) => {
      const currentRole = member.role as Permission;
      if (currentRole === nextRole) return;
      const displayName = member.name || member.email;
      setRoleUpdatingUserId(member.id);
      updateMemberRole({ workspaceId, userId: member.id, role: nextRole })
        .then(async () => {
          toast.success(
            i18n.t("admin.workspaces.members.role-update-success", {
              name: displayName,
              role: roleLabel(i18n, nextRole),
            }),
          );
          await revalidate(
            adminWorkspaceQuery,
            (vars: { id?: string } | undefined) => vars?.id === workspaceId,
          );
        })
        .catch((e: Error) => {
          toast.error(
            i18n.t("admin.workspaces.members.role-update-failed", {
              message: e.message,
            }),
          );
        })
        .finally(() => setRoleUpdatingUserId(null));
    },
    [i18n, revalidate, updateMemberRole, workspaceId],
  );

  const handleAdded = useCallback(() => {
    setPage(0);
  }, []);

  return (
    <Stack component="section" data-testid="workspace-members-section">
      <SettingsSectionHeading level={3}>
        {i18n.t("admin.workspaces.members.title")}
      </SettingsSectionHeading>
      <SettingsCollectionToolbar
        search={
          <Input
            aria-label={i18n.t("admin.workspaces.members.search-placeholder")}
            preFix={<SearchIcon aria-hidden />}
            placeholder={i18n.t("admin.workspaces.members.search-placeholder")}
            value={searchInput}
            onChange={setSearchInput}
            data-testid="member-search-input"
          />
        }
        actions={
          <>
            <Badge tone="neutral">{totalCount}</Badge>
            <Button
              type="button"
              variant="secondary"
              prefix={<UserPlusIcon aria-hidden />}
              onClick={() => setAddDialogOpen(true)}
              data-testid="add-member-btn"
            >
              {i18n.t("admin.workspaces.members.add")}
            </Button>
          </>
        }
      />

      {/* Rows */}
      <Table highlightOnHover>
        <TableHeader>
          <TableRow>
            <TableHead>{i18n.t("admin.workspaces.members.col-name")}</TableHead>
            <TableHead>
              {i18n.t("admin.workspaces.members.col-email")}
            </TableHead>
            <TableHead>{i18n.t("admin.workspaces.members.col-role")}</TableHead>
            <TableHead>
              {i18n.t("admin.workspaces.members.col-status")}
            </TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {members.length === 0 ? (
            <TableRow>
              <TableCell colSpan={5}>
                <SettingsEmptyState
                  title={
                    debouncedSearch
                      ? i18n.t("admin.workspaces.members.none-search")
                      : i18n.t("admin.workspaces.members.none")
                  }
                />
              </TableCell>
            </TableRow>
          ) : (
            members.map((member) => {
              const isOwner =
                member.id === ownerId || member.role === Permission.Owner;
              const currentRole = member.role as Permission;
              const availableRoleOptions = roleOptions.includes(currentRole)
                ? roleOptions
                : [currentRole, ...roleOptions];
              const displayName = member.name || member.email;
              return (
                <TableRow
                  key={member.id}
                  data-testid={`member-row-${member.id}`}
                >
                  <TableCell>
                    <Group wrap="nowrap">
                      <Avatar name={displayName} url={member.avatarUrl} />
                      <SettingsListItemTitle truncate>
                        {displayName}
                      </SettingsListItemTitle>
                    </Group>
                  </TableCell>
                  <TableCell>
                    <SettingsListItemMeta truncate>
                      {member.email}
                    </SettingsListItemMeta>
                  </TableCell>
                  <TableCell>
                    {isOwner ? (
                      <RoleBadge role={currentRole} />
                    ) : (
                      <MyoxusSelect
                        value={currentRole}
                        disabled={roleUpdatingUserId === member.id}
                        aria-label={i18n.t(
                          "admin.workspaces.members.role-select-label",
                          { name: displayName },
                        )}
                        data={availableRoleOptions.map((option) => ({
                          value: option,
                          label: roleLabel(i18n, option),
                        }))}
                        onChange={(value) =>
                          handleRoleChange(member, value as Permission)
                        }
                        data-testid={`member-role-select-${member.id}`}
                      />
                    )}
                  </TableCell>
                  <TableCell>
                    <StatusBadge
                      status={member.status as WorkspaceMemberStatus}
                    />
                  </TableCell>
                  <TableCell>
                    {!isOwner && (
                      <IconButton
                        icon={<UserMinusIcon aria-hidden />}
                        aria-label={i18n.t("admin.workspaces.members.remove")}
                        tooltip={i18n.t("admin.workspaces.members.remove")}
                        type="button"
                        variant="plain"
                        onClick={() =>
                          setRemoveTarget({ id: member.id, name: displayName })
                        }
                        disabled={isRevoking}
                        data-testid={`remove-member-btn-${member.id}`}
                      />
                    )}
                  </TableCell>
                </TableRow>
              );
            })
          )}
        </TableBody>
      </Table>

      {/* Pagination */}
      {totalPages > 1 && (
        <>
          <Divider />
          <SettingsToolbar justify="space-between">
            <SettingsStatusText>
              {i18n.t("admin.workspaces.members.page", {
                page: page + 1,
                total: totalPages,
              })}
            </SettingsStatusText>
            <Pagination
              totalCount={totalCount}
              pageNum={page}
              countPerPage={PAGE_SIZE}
              onPageChange={(_, nextPage) => setPage(nextPage)}
            />
          </SettingsToolbar>
        </>
      )}

      {/* Remove confirmation */}
      <AdminConfirmModal
        open={removeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRemoveTarget(null);
        }}
        title={i18n.t("admin.workspaces.members.remove-title")}
        description={
          removeTarget
            ? i18n.t("admin.workspaces.members.remove-desc", {
                name: removeTarget.name,
              })
            : ""
        }
        confirmText={i18n.t("admin.workspaces.members.remove")}
        danger
        onConfirm={handleRemoveConfirm}
        onCancel={() => setRemoveTarget(null)}
      />

      {/* Add Member dialog */}
      <AddMemberDialog
        open={addDialogOpen}
        onOpenChange={setAddDialogOpen}
        workspaceId={workspaceId}
        existingMemberIds={existingMemberIds}
        onAdded={handleAdded}
      />
    </Stack>
  );
}
