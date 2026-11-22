import type { StorageConstructor } from "../impls";
import { Sync } from "../sync";
import {
  TransportStoreManagerConsumer,
  type IndexOp,
} from "./transport-consumer";
import type { OpConsumer } from "@myoxus/infra/op";
import { Observable } from "rxjs";
import type { WorkerOps } from "./ops";
export type { WorkerManagerOps } from "./ops";

export class StoreManagerConsumer extends TransportStoreManagerConsumer {
  constructor(storages: StorageConstructor[]) {
    super(storages, Sync, (consumer, sync) =>
      bindIndex(consumer, sync as Sync),
    );
  }
}

function bindIndex(consumer: OpConsumer<WorkerOps>, sync: Sync) {
  const index = sync.indexer;
  consumer.registerGroup<IndexOp>({
    "indexerSync.state": () => index.state$,
    "indexerSync.docState": (id) => index.docState$(id),
    "indexerSync.addPriority": ({ docId, priority }) =>
      new Observable(() => index.addPriority(docId, priority)),
    "indexerSync.waitForCompleted": (_, ctx) =>
      index.waitForCompleted(ctx.signal),
    "indexerSync.waitForDocCompleted": (id, ctx) =>
      index.waitForDocCompleted(id, ctx.signal),
    "indexerSync.aggregate": ({ table, query, field, options }) =>
      index.aggregate(table, query, field, options),
    "indexerSync.search": ({ table, query, options }) =>
      index.search(table, query, options),
    "indexerSync.subscribeSearch": ({ table, query, options }) =>
      index.search$(table, query, options),
    "indexerSync.subscribeAggregate": ({ table, query, field, options }) =>
      index.aggregate$(table, query, field, options),
    "sync.enableBatterySaveMode": () => index.enableBatterySaveMode(),
    "sync.disableBatterySaveMode": () => index.disableBatterySaveMode(),
    "sync.pauseSync": () => sync.scheduleIndexPause(),
    "sync.resumeSync": () => sync.resumeIndex(),
  });
}
