/**
 * storage worker entry point (SharedWorker / Worker).
 *
 * This script is loaded as a Web Worker by `app.tsx`. It runs the
 * `StoreManagerConsumer` which owns all storage backends (IndexedDB, cloud
 * sync, BroadcastChannel) and exposes them to the main thread via an
 * `OpConsumer` message channel.
 *
 * The same bundle is used for both SharedWorker and dedicated Worker contexts:
 * - SharedWorker: `onconnect` fires for each connecting tab; a new
 *   `OpConsumer` is bound to the port for that tab.
 * - Dedicated Worker: the global `self` object is used directly as the
 *   communication target.
 */
import "@myoxus/core/bootstrap/worker";

import { type MessageCommunicapable, OpConsumer } from "@myoxus/infra/op";
import {
  ClientUpdateGate,
  createClientUpdateControlReader,
  startClientUpdateControlRuntime,
} from "@myoxus/storage";
import { broadcastChannelStorages } from "@myoxus/storage/broadcast-channel";
import {
  cloudStorages,
  configureMyoxusStorageClientContext,
  configureSocketAuthMethod,
  onClientUpdateControlChanged,
} from "@myoxus/storage/cloud";
import { idbStorages } from "@myoxus/storage/idb";
import {
  StoreManagerConsumer,
  type WorkerManagerOps,
} from "@myoxus/storage/worker/consumer";

configureMyoxusStorageClientContext({ client: "web" });
configureSocketAuthMethod((_endpoint, callback) => {
  callback({ clientKind: "web" });
});

startClientUpdateControlRuntime({
  gate: new ClientUpdateGate(),
  read: createClientUpdateControlReader(
    new URL("/graphql", globalThis.location.origin).href,
  ),
  subscribeWakeup: onClientUpdateControlChanged,
  addOnlineListener: (listener) =>
    globalThis.addEventListener("online", listener),
  removeOnlineListener: (listener) =>
    globalThis.removeEventListener("online", listener),
  createBroadcastChannel:
    typeof BroadcastChannel === "function"
      ? (name) => new BroadcastChannel(name)
      : undefined,
});

const consumer = new StoreManagerConsumer([
  ...idbStorages,
  ...broadcastChannelStorages,
  ...cloudStorages,
]);

if ("onconnect" in globalThis) {
  // Running as a SharedWorker: each connecting tab triggers onconnect.
  // Bind a separate OpConsumer to the MessagePort so that every tab gets its
  // own multiplexed communication channel over the shared consumer instance.
  (globalThis as any).onconnect = (event: MessageEvent) => {
    const port = event.ports[0];
    consumer.bindConsumer(new OpConsumer<WorkerManagerOps>(port));
  };
} else {
  // Running as a dedicated Worker: the global scope itself is the port.
  consumer.bindConsumer(
    new OpConsumer<WorkerManagerOps>(globalThis as MessageCommunicapable),
  );
}
