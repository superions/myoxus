import {
  ClientUpdateGate,
  createClientUpdateControlReader,
  startClientUpdateControlRuntime,
} from "@myoxus/storage";
import { onClientUpdateControlChanged } from "@myoxus/storage/cloud";

export const clientUpdateGate = new ClientUpdateGate();
const controlReader = createClientUpdateControlReader(
  new URL("/graphql", window.location.origin).href,
);

let stopRuntime: (() => void) | null = null;

export function rereadClientUpdateControl() {
  return clientUpdateGate.read(controlReader);
}

/** Starts the single window-side policy reader used by UI and data retries. */
export function startClientUpdateCoordinator(): () => void {
  if (stopRuntime) return stopRuntime;

  const stop = startClientUpdateControlRuntime({
    gate: clientUpdateGate,
    read: controlReader,
    subscribeWakeup: onClientUpdateControlChanged,
    addOnlineListener: (listener) =>
      window.addEventListener("online", listener),
    removeOnlineListener: (listener) =>
      window.removeEventListener("online", listener),
    createBroadcastChannel:
      typeof BroadcastChannel === "function"
        ? (name) => new BroadcastChannel(name)
        : undefined,
  });

  stopRuntime = () => {
    stop();
    stopRuntime = null;
  };
  return stopRuntime;
}
