import type {
  HelperClientEvents,
  HelperClientHandlers,
} from "@myoxus/desktop-api-contract";
import {
  helperEventChannelManifest,
  helperHandlerChannelManifest,
} from "@myoxus/desktop-api-contract";

import { createExposedMeta, parseExposedMeta } from "../shared/exposed-meta";
import { dialogHandlers } from "./dialog";
import { provideExposed } from "./provide";
import { storeHandlers } from "./storage";
import { workspaceEvents, workspaceHandlers } from "./workspace";

export const handlers = {
  store: storeHandlers,
  workspace: workspaceHandlers,
  dialog: dialogHandlers,
} satisfies HelperClientHandlers;

export const events = {
  workspace: workspaceEvents,
} satisfies HelperClientEvents;

provideExposed(
  parseExposedMeta(
    createExposedMeta(handlers, events),
    helperHandlerChannelManifest,
    helperEventChannelManifest,
    "helper exposed metadata",
  ),
);
