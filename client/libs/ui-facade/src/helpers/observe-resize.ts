// SPDX-License-Identifier: AGPL-3.0-or-later

type ResizeListener = {
  callback: (entry: ResizeObserverEntry) => void;
  dispose: () => void;
};

/** Each registry owns its lazy observer and listener disposal independently. */
function createResizeObserverRegistry() {
  let sharedResizeObserver: ResizeObserver | null = null;
  const resizeListeners = new WeakMap<Element, ResizeListener[]>();

  function getSharedResizeObserver() {
    return (sharedResizeObserver ??= new ResizeObserver((entries) => {
      for (const entry of entries) {
        const listeners = resizeListeners.get(entry.target) ?? [];
        for (const listener of listeners) listener.callback(entry);
      }
    }));
  }

  function observeResize(
    element: Element,
    callback: (entry: ResizeObserverEntry) => void,
  ) {
    const observer = getSharedResizeObserver();
    if (!resizeListeners.has(element)) observer.observe(element);

    const listener: ResizeListener = {
      callback,
      dispose: () => {
        const listeners = resizeListeners.get(element) ?? [];
        const next = listeners.filter((item) => item !== listener);
        if (next.length) {
          resizeListeners.set(element, next);
          return;
        }
        observer.unobserve(element);
        resizeListeners.delete(element);
      },
    };

    resizeListeners.set(element, [
      ...(resizeListeners.get(element) ?? []),
      listener,
    ]);
    return listener.dispose;
  }

  return observeResize;
}

// Masonry and the public Facade keep their existing independent registries.
export const observeResize = createResizeObserverRegistry();
export const observeFacadeResize = createResizeObserverRegistry();
