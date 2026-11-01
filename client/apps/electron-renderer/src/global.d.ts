import type {
  AppInfo,
  ClientEvents,
  ClientHandler,
} from "@myoxus/desktop-api-contract";
import type { SharedStorage } from "@myoxus/desktop-api-contract/bridge";

/**
 * Extends the global Window interface with the desktop bridge APIs that are
 * provided by the native shell at runtime.
 */
declare global {
  interface Window {
    __appInfo?: AppInfo;
    __apis?: ClientHandler;
    __events?: ClientEvents;
    __sharedStorage?: SharedStorage;
  }
}

export {};
