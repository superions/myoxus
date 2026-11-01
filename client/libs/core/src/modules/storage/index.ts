export {
  CacheStorage,
  GlobalCache,
  GlobalSessionState,
  GlobalState,
  writeGlobalStateConfirmed,
  readGlobalStateConfirmed,
} from "./providers/global";
export { StoreProvider } from "./providers/store";
export {
  GlobalCacheService,
  GlobalSessionStateService,
  GlobalStateService,
} from "./services/global";
export { StoreService } from "./services/store";

import { type Framework } from "@myoxus/infra";

import {
  IDBGlobalState,
  LocalStorageGlobalCache,
  LocalStorageGlobalState,
  SessionStorageGlobalSessionState,
} from "./impls/storage";
import {
  CacheStorage,
  GlobalCache,
  GlobalSessionState,
  GlobalState,
} from "./providers/global";
import { StoreProvider } from "./providers/store";
import {
  GlobalCacheService,
  GlobalSessionStateService,
  GlobalStateService,
} from "./services/global";
import { StoreService } from "./services/store";

export const configureStorageModule = (framework: Framework) => {
  framework.service(GlobalStateService, [GlobalState]);
  framework.service(GlobalCacheService, [GlobalCache]);
  framework.service(GlobalSessionStateService, [GlobalSessionState]);
  framework.service(StoreService, [StoreProvider]);
};

export function configureLocalStorageStateStorageImpls(framework: Framework) {
  framework.impl(GlobalCache, LocalStorageGlobalCache);
  framework.impl(GlobalState, LocalStorageGlobalState);
  framework.impl(CacheStorage, IDBGlobalState);
}

export function configureCommonGlobalStorageImpls(framework: Framework) {
  framework.impl(GlobalSessionState, SessionStorageGlobalSessionState);
}
