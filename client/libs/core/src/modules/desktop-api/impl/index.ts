import { getDesktopBridge } from "@myoxus/desktop-api-contract/bridge";
import { Service } from "@myoxus/infra";

import type { DesktopApiProvider } from "../provider";

function requireDesktopApi() {
  const bridge = getDesktopBridge();
  if (!bridge) {
    throw new Error("Failed to initialize DesktopApiImpl");
  }

  return bridge;
}

export class DesktopApiImpl extends Service implements DesktopApiProvider {
  handler: DesktopApiProvider["handler"];
  events: DesktopApiProvider["events"];
  sharedStorage: DesktopApiProvider["sharedStorage"];
  appInfo: DesktopApiProvider["appInfo"];

  constructor() {
    super();

    const desktopApi = requireDesktopApi();
    this.handler = desktopApi.apis;
    this.events = desktopApi.events;
    this.sharedStorage = desktopApi.sharedStorage;
    this.appInfo = desktopApi.appInfo;
  }
}
