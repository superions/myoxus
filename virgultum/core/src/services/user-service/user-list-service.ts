import type { ReadonlySignal } from "@preact/signals-core";
import { createIdentifier } from "../../primitives/di/index";
import type { ExtensionType } from "../../store/index";

import type { MyoxusUserInfo } from "./types";

export interface UserListService {
  users$: ReadonlySignal<MyoxusUserInfo[]>;
  isLoading$: ReadonlySignal<boolean>;
  searchText$: ReadonlySignal<string>;
  hasMore$: ReadonlySignal<boolean>;
  loadMore(): void;
  search(keyword: string): void;
}

export const UserListProvider = createIdentifier<UserListService>(
  "myoxus-user-list-service",
);

export function UserListServiceExtension(
  service: UserListService,
): ExtensionType {
  return {
    setup(di) {
      di.addImpl(UserListProvider, () => service);
    },
  };
}
