import { StoreProvider } from "@myoxus/core/modules/storage";
import { getDesktopBridge } from "@myoxus/desktop-api-contract/bridge";
import type { Framework } from "@myoxus/infra";
import { OpClient } from "@myoxus/infra/op";
import { StoreManagerClient } from "@myoxus/storage/worker/client";
import { setTelemetryTransport } from "@myoxus/track";
import { v4 as uuid } from "uuid";

function createStoreManagerClient() {
  const desktopBridge = getDesktopBridge();
  if (!desktopBridge) {
    throw new Error("Desktop bridge is unavailable in the Electron renderer");
  }
  const { port1: portForOpClient, port2: portForWorker } = new MessageChannel();
  let portFromWorker: MessagePort | null = null;
  let portId = uuid();

  const handleMessage = (ev: MessageEvent) => {
    if (
      ev.data.type === "electron:worker-connect" &&
      ev.data.portId === portId
    ) {
      portFromWorker = ev.ports[0];
      // connect portForWorker and portFromWorker
      portFromWorker.addEventListener("message", (ev) => {
        portForWorker.postMessage(ev.data, [...ev.ports]);
      });
      portForWorker.addEventListener("message", (ev) => {
        // oxlint-disable-next-line no-non-null-assertion
        portFromWorker!.postMessage(ev.data, [...ev.ports]);
      });
      portForWorker.start();
      portFromWorker.start();
    }
  };

  window.addEventListener("message", handleMessage);

  desktopBridge.apis.worker
    .connectWorker("myoxus-shared-worker", portId)
    .catch((err) => {
      console.error("failed to connect worker", err);
    });

  const storeManager = new StoreManagerClient(new OpClient(portForOpClient));
  portForOpClient.start();
  return storeManager;
}

export function setupStoreManager(framework: Framework) {
  const storeManagerClient = createStoreManagerClient();
  setTelemetryTransport(storeManagerClient.telemetry);
  // beforeunload may be canceled by a dirty session. Keep worker ports alive
  // until the page actually leaves; BFCache must retain its suspended client.
  window.addEventListener("pagehide", (event) => {
    if (!event.persisted) storeManagerClient.dispose();
  });
  window.addEventListener("focus", () => {
    storeManagerClient.resume();
  });
  window.addEventListener("click", () => {
    storeManagerClient.resume();
  });
  window.addEventListener("blur", () => {
    storeManagerClient.pause();
  });

  framework.impl(StoreProvider, {
    openStore(key, options) {
      const { store, dispose } = storeManagerClient.open(key, options);

      return {
        store,
        dispose: () => {
          dispose();
        },
      };
    },
  });
}
