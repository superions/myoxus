import { createIdentifier } from "@myoxus/infra";
import type {
  StoreClient,
  WorkerInitOptions,
} from "@myoxus/storage/worker/client";

export interface StoreProvider {
  /**
   * Open a store with the given options, if the store with the given key already exists, it will be returned.
   *
   * in environment with SharedWorker support, the store also can be shared with other tabs/windows.
   *
   * @param key - the key of the store, can used to share the store with other tabs/windows.
   * @param options - the options to open the store.
   */
  openStore(
    key: string,
    options: WorkerInitOptions,
  ): {
    store: StoreClient;
    dispose: () => void;
  };
}

export const StoreProvider = createIdentifier<StoreProvider>("StoreProvider");
