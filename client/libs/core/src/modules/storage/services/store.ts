import { Service } from "@myoxus/infra";
import type { WorkerInitOptions } from "@myoxus/storage/worker/client";

import type { StoreProvider } from "../providers/store";

export class StoreService extends Service {
  constructor(private readonly storeProvider: StoreProvider) {
    super();
  }

  openStore(key: string, options: WorkerInitOptions) {
    return this.storeProvider.openStore(key, options);
  }
}
