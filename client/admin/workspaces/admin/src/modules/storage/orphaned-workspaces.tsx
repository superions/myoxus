// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Orphaned workspaces page — lists workspaces with no owner (personal workspaces
 * whose owner account has been deleted) and allows re-assigning ownership to an
 * existing user or permanently deleting the workspace.
 *
 * Pagination is manual (skip/take), not TanStack Table.  A separate
 * `orphanedWorkspacesCountQuery` provides the total count for page-range display.
 * The reassignment flow loads all users via `listUsersQuery`, lets the admin pick
 * a new owner from the Facade select, and calls `reassignWorkspaceOwnerMutation`.
 * The delete flow prompts the admin to type the workspace ID before confirming
 * the irreversible `deleteWorkspaceMutation`.
 * After reassignment or deletion both the list and count queries are revalidated.
 */
import { adminToast as toast } from "@myoxus/admin/notifications";
import {
  adminDeleteWorkspaceMutation,
  listUsersQuery,
  orphanedWorkspacesCountQuery,
  orphanedWorkspacesQuery,
  reassignWorkspaceOwnerMutation,
} from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import {
  Button,
  Group,
  Select,
  SettingsEmptyState,
  SettingsNotice,
  SettingsSkeleton,
  SettingsListItemMeta,
  SettingsHeadingGroup,
  SettingsSectionHeading,
  SettingsSectionDescription,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@myoxus/ui-facade";
import { useState } from "react";

import { AdminTypeConfirmModal } from "../../components/shared/admin-type-confirm-modal";
import { useMutation } from "../../use-mutation";
import { useQuery } from "../../use-query";
import { formatAdminDate } from "../../utils/locale-format";

const PAGE_SIZE = 20;

/**
 * Admin page for managing orphaned (ownerless) workspaces.
 *
 * `reassigning` owns the visible editor; `reassignPending` locks its write
 * until acknowledgement and list/count readback finish.
 * `selectedUser` maps workspace ID → chosen user ID from the select dropdown.
 */
export function OrphanedWorkspacesContent() {
  const i18n = useI18n();
  const [skip, setSkip] = useState(0);
  const [reassigning, setReassigning] = useState<string | null>(null);
  const [reassignPending, setReassignPending] = useState(false);
  const [selectedUser, setSelectedUser] = useState<Record<string, string>>({});
  const [deleteTarget, setDeleteTarget] = useState<{
    id: string;
    name: string | null;
  } | null>(null);
  const [deleting, setDeleting] = useState(false);

  const workspaceQuery = useQuery(
    { query: orphanedWorkspacesQuery, variables: { skip, take: PAGE_SIZE } },
    { keepPreviousData: true },
  );
  const countQuery = useQuery({
    query: orphanedWorkspacesCountQuery,
  });
  const usersQuery = useQuery({
    query: listUsersQuery,
    variables: { filter: { first: 200, skip: 0 } },
  });

  const { trigger } = useMutation({ mutation: reassignWorkspaceOwnerMutation });
  // Use admin.deleteWorkspace (admin-level, bypasses owner permission check).
  // Orphaned workspaces have no owner → regular deleteWorkspace fails with "action forbidden".
  const { trigger: deleteWorkspace } = useMutation({
    mutation: adminDeleteWorkspaceMutation,
  });

  const workspaces = workspaceQuery.data?.admin?.orphanedWorkspaces ?? [];
  const total = countQuery.data?.admin?.orphanedWorkspacesCount;
  const users = usersQuery.data?.admin?.users ?? [];
  const resources = workspaces.length
    ? [workspaceQuery, countQuery, usersQuery]
    : [workspaceQuery, countQuery];
  const error = resources.find((resource) => resource.error)?.error;
  const isLoading = resources.some((resource) => resource.isLoading);
  const isValidating = resources.some((resource) => resource.isValidating);
  const refresh = async () => {
    // Query errors render locally; recovery must never repeat an applied write.
    await workspaceQuery.mutate(undefined, { throwOnError: false });
    await countQuery.mutate(undefined, { throwOnError: false });
    if (workspaces.length)
      await usersQuery.mutate(undefined, { throwOnError: false });
  };

  const handleReassign = async (workspaceId: string) => {
    const newOwnerId = selectedUser[workspaceId];
    if (!newOwnerId || reassignPending || deleting) return;
    setReassignPending(true);
    try {
      const result = await trigger({ workspaceId, newOwnerId });
      if (result?.admin?.reassignWorkspaceOwner !== true)
        throw new Error(
          i18n.t("admin.workspaces.orphaned-page.reassign-failed"),
        );
      setReassigning(null);
      toast.success(i18n.t("admin.workspaces.orphaned-page.reassign-success"));
      await refresh();
    } catch {
      toast.error(i18n.t("admin.workspaces.orphaned-page.reassign-failed"));
    } finally {
      setReassignPending(false);
    }
  };

  const handleDeleteConfirm = async () => {
    if (!deleteTarget || deleting || reassignPending) return;
    setDeleting(true);
    try {
      const result = await deleteWorkspace({ id: deleteTarget.id });
      if (result?.admin?.deleteWorkspace !== true)
        throw new Error(i18n.t("com.myoxus.common.operation-failed"));
      toast.success(
        i18n.t("admin.workspaces.orphaned-page.delete-success", {
          name: deleteTarget.name ?? deleteTarget.id,
        }),
      );
      setDeleteTarget(null);
      await refresh();
    } catch (e) {
      toast.error(
        i18n.t("admin.workspaces.orphaned-page.delete-failed", {
          message: (e as Error).message,
        }),
      );
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Stack component="section">
      <SettingsHeadingGroup>
        <SettingsSectionHeading level={3}>
          {i18n.t("admin.workspaces.orphaned-page.title", {
            total:
              error || isLoading || total === undefined ? "—" : String(total),
          })}
        </SettingsSectionHeading>
        <SettingsSectionDescription>
          {i18n.t("admin.storage.orphaned-workspaces-description")}
        </SettingsSectionDescription>
      </SettingsHeadingGroup>
      {error ? (
        <SettingsNotice
          tone="error"
          title={i18n.t("com.myoxus.settings.common.load-error")}
        >
          {error.message}
          <Group>
            <Button disabled={isValidating} onClick={() => void refresh()}>
              {i18n.t("admin.error.retry")}
            </Button>
          </Group>
        </SettingsNotice>
      ) : isLoading ? (
        <SettingsSkeleton />
      ) : workspaces.length === 0 ? (
        <SettingsEmptyState
          title={i18n.t("admin.workspaces.orphaned-page.none")}
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>
                {i18n.t("admin.workspaces.orphaned-page.col-id")}
              </TableHead>
              <TableHead>
                {i18n.t("admin.workspaces.orphaned-page.col-name")}
              </TableHead>
              <TableHead>
                {i18n.t("admin.workspaces.orphaned-page.col-members")}
              </TableHead>
              <TableHead>
                {i18n.t("admin.workspaces.orphaned-page.col-created")}
              </TableHead>
              <TableHead>
                {i18n.t("admin.workspaces.orphaned-page.col-assign")}
              </TableHead>
              <TableHead>
                {i18n.t("admin.workspaces.orphaned-page.col-delete")}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {workspaces.map((ws) => (
              <TableRow key={ws.id}>
                <TableCell>
                  <SettingsListItemMeta breakAnywhere>
                    {ws.id}
                  </SettingsListItemMeta>
                </TableCell>
                <TableCell>{ws.name ?? "—"}</TableCell>
                <TableCell>{ws.memberCount}</TableCell>
                <TableCell>
                  {formatAdminDate(i18n.language, ws.createdAt)}
                </TableCell>
                <TableCell>
                  {reassigning === ws.id ? (
                    <Group wrap="wrap">
                      <Select
                        disabled={reassignPending || deleting}
                        aria-label={i18n.t(
                          "admin.workspaces.orphaned-page.select-user",
                        )}
                        data={users.map(
                          (u: {
                            id: string;
                            email: string;
                            name: string | null;
                          }) => ({
                            value: u.id,
                            label: `${u.name ?? u.email} (${u.email})`,
                          }),
                        )}
                        placeholder={i18n.t(
                          "admin.workspaces.orphaned-page.select-user",
                        )}
                        value={selectedUser[ws.id] || null}
                        onChange={(value) =>
                          setSelectedUser((prev) => ({
                            ...prev,
                            [ws.id]: value,
                          }))
                        }
                      />
                      <Button
                        disabled={
                          !selectedUser[ws.id] || reassignPending || deleting
                        }
                        loading={reassignPending}
                        onClick={() => handleReassign(ws.id)}
                      >
                        {i18n.t("admin.common.save")}
                      </Button>
                      <Button
                        variant="plain"
                        disabled={reassignPending || deleting}
                        onClick={() => setReassigning(null)}
                      >
                        {i18n.t("admin.common.cancel")}
                      </Button>
                    </Group>
                  ) : (
                    <Button
                      variant="secondary"
                      disabled={reassignPending || deleting}
                      onClick={() => setReassigning(ws.id)}
                    >
                      {i18n.t("admin.workspaces.orphaned-page.assign")}
                    </Button>
                  )}
                </TableCell>
                <TableCell>
                  <Button
                    variant="error"
                    disabled={reassignPending || deleting}
                    onClick={() =>
                      setDeleteTarget({ id: ws.id, name: ws.name ?? null })
                    }
                  >
                    {i18n.t("admin.workspaces.orphaned-page.delete")}
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {!error && !isLoading && total !== undefined && total > PAGE_SIZE && (
        <Group justify="flex-end" wrap="wrap">
          <Button
            variant="secondary"
            disabled={skip === 0 || reassignPending || deleting || isValidating}
            onClick={() => setSkip((s) => Math.max(0, s - PAGE_SIZE))}
          >
            {i18n.t("admin.common.previous")}
          </Button>
          <SettingsListItemMeta>
            {i18n.t("admin.workspaces.orphaned-page.page-range", {
              from: String(skip + 1),
              to: String(Math.min(skip + PAGE_SIZE, total)),
              total: String(total),
            })}
          </SettingsListItemMeta>
          <Button
            variant="secondary"
            disabled={
              skip + PAGE_SIZE >= total ||
              reassignPending ||
              deleting ||
              isValidating
            }
            onClick={() => setSkip((s) => s + PAGE_SIZE)}
          >
            {i18n.t("admin.common.next")}
          </Button>
        </Group>
      )}

      <AdminTypeConfirmModal
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title={i18n.t("admin.workspaces.orphaned-page.delete-confirm-title")}
        description={
          <>
            {i18n.t(
              "admin.workspaces.orphaned-page.delete-confirm-desc-prefix",
            )}{" "}
            <SettingsListItemMeta breakAnywhere>
              {deleteTarget?.id}
            </SettingsListItemMeta>
            {deleteTarget?.name ? ` ("${deleteTarget.name}")` : ""}.{" "}
            {i18n.t("admin.workspaces.orphaned-page.cannot-undo")}
          </>
        }
        targetText={deleteTarget?.id ?? ""}
        inputPlaceholder={i18n.t(
          "admin.workspaces.orphaned-page.delete-input-placeholder",
        )}
        confirmText={
          deleting
            ? i18n.t("admin.workspaces.orphaned-page.deleting")
            : i18n.t("admin.workspaces.orphaned-page.delete-confirm-btn")
        }
        onConfirm={handleDeleteConfirm}
        onCancel={() => setDeleteTarget(null)}
      />
    </Stack>
  );
}

export { OrphanedWorkspacesContent as Component };
