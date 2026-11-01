// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Organization-scoped user lifecycle actions.
 *
 * The old Accounts page owned these mutations historically. In the redesign,
 * the Organization Members tab is the only UI surface that edits user profile
 * data and global admin capability, so the hooks live beside that domain. The
 * profile update deliberately writes only `ManageUserInput`; admin status is a
 * separate audited action through `setUserAdmin`.
 */
import {
  useMutateQueryResource,
  useMutation,
} from "@myoxus/admin/use-mutation";
import {
  adminSetUserAdminMutation,
  createChangePasswordUrlMutation,
  deleteUserMutation,
  disableUserMutation,
  enableUserMutation,
  listUsersQuery,
  updateAccountMutation,
} from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import { notify } from "@myoxus/ui-facade";
import { useCallback, useMemo, useState } from "react";

import { mutateWithToast } from "../../hooks/mutate-with-toast";
import { useAsyncAction } from "../../hooks/use-async-action";

type UserProfileInput = {
  userId: string;
  name?: string | null;
  email?: string | null;
};

/** Resolves after profile persistence; false preserves the caller's draft. */
export const useUpdateUser = () => {
  const i18n = useI18n();
  const { trigger: updateAccount, isMutating: updating } = useMutation({
    mutation: updateAccountMutation,
  });
  const revalidate = useMutateQueryResource();

  const update = useCallback(
    async ({ userId, name, email }: UserProfileInput) => {
      const result = await mutateWithToast(
        () => updateAccount({ id: userId, input: { name, email } }),
        i18n.t("admin.organization.members.toast.profile-updated"),
        i18n.t("admin.organization.members.toast.profile-update-failed"),
      );
      if (result === undefined) return false;
      await revalidate(listUsersQuery);
      return true;
    },
    [i18n, revalidate, updateAccount],
  );

  return { updating, update };
};

/** Generates a one-time password-reset link for the selected user. */
export const useResetUserPassword = () => {
  const i18n = useI18n();
  const [resetPasswordLink, setResetPasswordLink] = useState("");
  const { trigger: resetPassword } = useMutation({
    mutation: createChangePasswordUrlMutation,
  });

  const onResetPassword = useCallback(
    async (id: string, callback?: () => void) => {
      setResetPasswordLink("");
      return resetPassword({
        userId: id,
      })
        .then((res) => {
          setResetPasswordLink(res.admin.createChangePasswordUrl);
          callback?.();
        })
        .catch((error) => {
          notify.error({
            title: i18n.t(
              "admin.organization.members.toast.reset-link-failed",
              {
                message: error?.message ?? String(error),
              },
            ),
          });
        });
    },
    [i18n, resetPassword],
  );

  return useMemo(
    () => ({ resetPasswordLink, onResetPassword }),
    [onResetPassword, resetPasswordLink],
  );
};

/** Permanently deletes a user account and refreshes the member list. */
export const useDeleteUser = () => {
  const i18n = useI18n();
  const { trigger: deleteUserById, isMutating: deleting } = useMutation({
    mutation: deleteUserMutation,
  });
  const revalidate = useMutateQueryResource();

  const deleteUser = useAsyncAction(
    async (id: string, callback?: () => void) => {
      const result = await mutateWithToast(
        () => deleteUserById({ id }),
        i18n.t("admin.organization.members.toast.deleted"),
        i18n.t("admin.organization.members.toast.delete-failed"),
      );
      if (result) {
        // Clear committed-deleted detail state before the fallible list read.
        callback?.();
        await revalidate(listUsersQuery);
      }
    },
    [deleteUserById, i18n, revalidate],
  );
  return { deleteUser, deleting };
};

/** Re-enables a disabled user account. */
export const useEnableUser = () => {
  const i18n = useI18n();
  const { trigger: enableUserById } = useMutation({
    mutation: enableUserMutation,
  });
  const revalidate = useMutateQueryResource();

  return useAsyncAction(
    async (id: string, callback?: () => void) => {
      const result = await mutateWithToast(
        () => enableUserById({ id }),
        (response) =>
          i18n.t("admin.organization.members.toast.enabled", {
            email: response.admin.enableUser.email,
          }),
        i18n.t("admin.organization.members.toast.enable-failed"),
      );
      if (result) {
        await revalidate(listUsersQuery);
        callback?.();
      }
    },
    [enableUserById, i18n, revalidate],
  );
};

/** Disables a user account, preventing new sign-ins. */
export const useDisableUser = () => {
  const i18n = useI18n();
  const { trigger: disableUserById } = useMutation({
    mutation: disableUserMutation,
  });
  const revalidate = useMutateQueryResource();

  return useAsyncAction(
    async (id: string, callback?: () => void) => {
      const result = await mutateWithToast(
        () => disableUserById({ id }),
        (response) =>
          i18n.t("admin.organization.members.toast.disabled", {
            email: response.admin.banUser.email,
          }),
        i18n.t("admin.organization.members.toast.disable-failed"),
      );
      if (result) {
        await revalidate(listUsersQuery);
        callback?.();
      }
    },
    [disableUserById, i18n, revalidate],
  );
};

/** Toggles the single global capability exposed by Organization Members. */
export const useSetUserAdmin = () => {
  const { trigger: setAdmin } = useMutation({
    mutation: adminSetUserAdminMutation,
  });
  const revalidate = useMutateQueryResource();

  return useAsyncAction(
    async (userId: string, isAdmin: boolean, callback?: () => void) => {
      await setAdmin({ userId, isAdmin });
      await revalidate(listUsersQuery);
      callback?.();
    },
    [revalidate, setAdmin],
  );
};
