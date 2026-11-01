import type {
  AppInfo,
  ClientEvents,
  ClientHandler,
} from "@myoxus/desktop-api-contract";
import type { SharedStorage } from "@myoxus/desktop-api-contract/bridge";
import { createIdentifier } from "@myoxus/infra";

// The provider is a platform-neutral desktop contract. Electron wires these
// globals through preload, but browser builds may compile the types without
// depending on Electron app sources.
export interface DesktopApiProvider {
  handler?: ClientHandler;
  events?: ClientEvents;
  sharedStorage?: SharedStorage;
  appInfo: AppInfo;
}

export const DesktopApiProvider =
  createIdentifier<DesktopApiProvider>("DesktopApiProvider");
