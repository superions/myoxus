// SPDX-License-Identifier: AGPL-3.0-or-later

type ObserveIntersection = {
  callback: (entry: IntersectionObserverEntry) => void;
  dispose: () => void;
};

let sharedObserver: IntersectionObserver | null = null;
const elementListeners = new WeakMap<Element, ObserveIntersection[]>();

function getIntersectionObserver(): IntersectionObserver {
  if (sharedObserver) {
    return sharedObserver;
  }

  sharedObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const listeners = elementListeners.get(entry.target) ?? [];
      for (const listener of listeners) {
        listener.callback(entry);
      }
    }
  });

  return sharedObserver;
}

function removeListener(element: Element, listener: ObserveIntersection): void {
  const listeners = elementListeners.get(element) ?? [];
  const nextListeners = listeners.filter((item) => item !== listener);

  if (nextListeners.length === 0) {
    getIntersectionObserver().unobserve(element);
    elementListeners.delete(element);
    return;
  }

  elementListeners.set(element, nextListeners);
}

/**
 * Shares one IntersectionObserver across facade consumers while keeping each
 * element callback independently disposable. This avoids importing the legacy
 * component helper from product paths and keeps observer lifetime explicit.
 */
export function observeIntersection(
  element: Element,
  callback: ObserveIntersection["callback"],
): () => void {
  const observer = getIntersectionObserver();
  const existingListeners = elementListeners.get(element) ?? [];
  const listener: ObserveIntersection = {
    callback,
    dispose: () => removeListener(element, listener),
  };

  if (existingListeners.length === 0) {
    observer.observe(element);
  }

  elementListeners.set(element, [...existingListeners, listener]);

  return listener.dispose;
}
