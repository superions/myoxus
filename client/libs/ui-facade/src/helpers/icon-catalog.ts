// SPDX-License-Identifier: AGPL-3.0-or-later

export type IconCatalog = typeof import("@myoxus/icons/catalog");
type CatalogSnapshot =
  | { status: "idle" | "pending" }
  | { status: "ready"; catalog: IconCatalog }
  | { status: "error"; error: unknown };

const idle: CatalogSnapshot = { status: "idle" };
let snapshot: CatalogSnapshot = idle;
let request: Promise<void> | undefined;
const subscribers = new Set<() => void>();

export const getIconCatalogSnapshot = () => snapshot;
export const getServerIconCatalogSnapshot = () => idle;
export function subscribeIconCatalog(callback: () => void) {
  subscribers.add(callback);
  return () => subscribers.delete(callback);
}
function publish(next: CatalogSnapshot) {
  snapshot = next;
  for (const callback of subscribers) callback();
}

/**
 * Mounted demand starts idle loading; only the picker explicitly retries errors.
 * Snapshot reads are pure. Disposal removes one listener without cancelling a
 * shared import or changing persisted icon data. Evaluation errors remain errors
 * when the module loader cannot recover them on another attempt.
 */
export function loadIconCatalog() {
  if (request || snapshot.status === "ready") return;
  request = import("@myoxus/icons/catalog").then(
    (catalog) => publish({ status: "ready", catalog }),
    (error: unknown) => {
      request = undefined;
      publish({ status: "error", error });
    },
  );
  publish({ status: "pending" });
}
