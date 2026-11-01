import type { Signal } from "@preact/signals-core";
import { createIdentifier } from "@virgultum/global/di";
import type { ExtensionType } from "@virgultum/store";

import type { MyoxusUserInfo } from "./types";

export interface UserService {
  currentUserInfo$: Signal<MyoxusUserInfo | null>;
  userInfo$(id: string): Signal<MyoxusUserInfo | null>;
  isLoading$(id: string): Signal<boolean>;
  error$(id: string): Signal<string | null>; // user friendly error string
  revalidateUserInfo(id: string): void;
}

export const UserProvider = createIdentifier<UserService>(
  "myoxus-user-service",
);

export function UserServiceExtension(service: UserService): ExtensionType {
  return {
    setup(di) {
      di.addImpl(UserProvider, () => service);
    },
  };
}
