import {
  mainEventChannelManifest,
  mainHandlerChannelManifest,
} from "@myoxus/desktop-api-contract";

import { createExposedMeta, parseExposedMeta } from "../shared/exposed-meta";
import { allEvents as events } from "./events";
import { allHandlers as handlers } from "./handlers";

// this will be used by preload script to expose all handlers and events to the renderer process
// - register in exposeInMainWorld in preload
// - provide type hints
export { events, handlers };

export const getExposedMeta = () =>
  parseExposedMeta(
    createExposedMeta(handlers, events),
    mainHandlerChannelManifest,
    mainEventChannelManifest,
    "main exposed metadata",
  );

export type MainIPCHandlerMap = typeof handlers;
export type MainIPCEventMap = typeof events;
