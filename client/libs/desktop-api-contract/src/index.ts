// SPDX-License-Identifier: MIT

export * from "./dto";
export * from "./events";
export * from "./handlers";
export * from "./server-routing";

import {
  clientEventChannelManifest,
  helperEventChannelManifest,
  mainEventChannelManifest,
} from "./events";
import {
  clientHandlerChannelManifest,
  helperHandlerChannelManifest,
  mainHandlerChannelManifest,
} from "./handlers";

export const desktopRuntimeChannelManifest = {
  main: {
    handlers: mainHandlerChannelManifest,
    events: mainEventChannelManifest,
  },
  helper: {
    handlers: helperHandlerChannelManifest,
    events: helperEventChannelManifest,
  },
  bridge: {
    handlers: clientHandlerChannelManifest,
    events: clientEventChannelManifest,
  },
} as const;

export type DesktopRuntimeChannelManifest =
  typeof desktopRuntimeChannelManifest;
