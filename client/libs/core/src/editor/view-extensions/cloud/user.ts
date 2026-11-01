import type {
  AuthService,
  PublicUserService,
} from "@myoxus/core/modules/server";
import { UserFriendlyError } from "@myoxus/error";
import {
  type MyoxusUserInfo,
  UserServiceExtension,
} from "@virgultum/editor/shared/services";

export function patchUserExtensions(
  publicUserService: PublicUserService,
  authService: AuthService,
) {
  return UserServiceExtension({
    currentUserInfo$: authService.session.account$.map((account) => {
      if (!account) {
        return null;
      }
      return {
        id: account.id,
        name: account.label,
        avatar: account.avatar,
        removed: false,
      } as MyoxusUserInfo;
    }).signal,

    userInfo$(id) {
      return publicUserService.publicUser$(id).signal;
    },

    isLoading$(id) {
      return publicUserService.isLoading$(id).signal;
    },

    error$(id) {
      return publicUserService.error$(id).selector((error) => {
        if (error) {
          return UserFriendlyError.fromAny(error).name;
        } else {
          return null;
        }
      }).signal;
    },
    revalidateUserInfo(id) {
      publicUserService.revalidate(id);
    },
  });
}
