import "@myoxus/core/bootstrap/worker";

import { getDesktopBridge } from "@myoxus/desktop-api-contract/bridge";
import { OpConsumer } from "@myoxus/infra/op";
import { broadcastChannelStorages } from "@myoxus/storage/broadcast-channel";
import {
  cloudStorages,
  configureMyoxusStorageClientContext,
} from "@myoxus/storage/cloud";
import { bindNativeDBApis, sqliteStorages } from "@myoxus/storage/sqlite";
import {
  StoreManagerConsumer,
  type WorkerManagerOps,
} from "@myoxus/storage/worker/consumer";

const desktopBridge = getDesktopBridge();
if (!desktopBridge) {
  throw new Error("Desktop bridge is unavailable in the Electron worker");
}
bindNativeDBApis(desktopBridge.apis.store);

configureMyoxusStorageClientContext({ client: "myoxus-electron" });

const storeManager = new StoreManagerConsumer([
  ...sqliteStorages,
  ...broadcastChannelStorages,
  ...cloudStorages,
]);

window.addEventListener("message", (ev) => {
  if (ev.data.type === "electron:worker-connect") {
    const port = ev.ports[0];

    const consumer = new OpConsumer<WorkerManagerOps>(port);
    storeManager.bindConsumer(consumer);
  }
});
