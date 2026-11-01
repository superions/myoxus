import "@myoxus/core/bootstrap/electron";
import "@myoxus/core/bootstrap/cleanup";
import "@myoxus/theme/client.css";
import "./global.css";

import { getDesktopBridge } from "@myoxus/desktop-api-contract/bridge";
import { bindNativeDBApis } from "@myoxus/storage/sqlite";

import { startThemeAutoReload } from "./runtime-theme";

const desktopBridge = getDesktopBridge();
if (!desktopBridge) {
  throw new Error("Desktop bridge is unavailable in the Electron renderer");
}
bindNativeDBApis(desktopBridge.apis.store);

startThemeAutoReload("app");
