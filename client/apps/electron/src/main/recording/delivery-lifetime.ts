// SPDX-License-Identifier: AGPL-3.0-or-later
import type { WebContents } from "electron";

/** Reopening the same saved recording starts a fresh visibility interval.
 * The owner cancels this interval on a state change or feature teardown. */
export function createRecordingCompletionTimeout(hide: (id: number) => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clear = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  return {
    clear,
    schedule(id: number) {
      clear();
      timer = setTimeout(() => {
        timer = undefined;
        hide(id);
      }, 10_000);
    },
  };
}

/** SPA navigation keeps pending delivery alive; a replaced renderer cannot
 * complete it. The caller fences its claim before publishing a retry state. */
export function bindRecordingDeliveryLifetime(
  sender: WebContents,
  interrupted: () => void,
) {
  const navigating = (
    _event: unknown,
    _url: string,
    inPlace: boolean,
    mainFrame: boolean,
  ) => {
    if (mainFrame && !inPlace) interrupted();
  };
  sender.on("did-start-navigation", navigating);
  sender.on("render-process-gone", interrupted);
  sender.on("destroyed", interrupted);
  return () => {
    sender.removeListener("did-start-navigation", navigating);
    sender.removeListener("render-process-gone", interrupted);
    sender.removeListener("destroyed", interrupted);
  };
}
