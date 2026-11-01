import { ConfigExtensionFactory } from "@virgultum/std";

export interface ClipboardConfig {
  /**
   * When true, the clipboard service falls back to `document.execCommand()`
   * for copy/cut/paste when the Clipboard API (`navigator.clipboard`) is not
   * available. Set by the server admin via `client.clipboardHttpFallback`.
   *
   * @default false
   */
  httpFallback?: boolean;
}

export const ClipboardConfigExtension =
  ConfigExtensionFactory<ClipboardConfig>("myoxus:clipboard");
