import path from "node:path";

import { type SpaceType } from "@myoxus/storage";

import { mainRPC } from "../main-rpc";

let _appDataPath = "";

export async function getAppDataPath() {
  if (_appDataPath) {
    return _appDataPath;
  }
  _appDataPath = await mainRPC.getPath("sessionData");
  return _appDataPath;
}

export async function getWorkspacesBasePath() {
  return path.join(await getAppDataPath(), "workspaces");
}

export async function getSpaceBasePath(spaceType: SpaceType) {
  return path.join(
    await getAppDataPath(),
    spaceType === "userspace" ? "userspaces" : "workspaces",
  );
}

export function escapeFilename(name: string) {
  // replace all special characters with '_' and replace repeated '_' with a single '_' and remove trailing '_'
  return name
    .replaceAll(/[\\/!@#$%^&*()+~`"':;,?<>|]/g, "_")
    .split("_")
    .filter(Boolean)
    .join("_");
}

export async function getSpaceDBPath(
  peer: string,
  spaceType: SpaceType,
  id: string,
) {
  return path.join(
    await getSpaceBasePath(spaceType),
    escapeFilename(peer),
    id,
    "storage.db",
  );
}

export async function getDeletedWorkspacesBasePath() {
  return path.join(await getAppDataPath(), "deleted-workspaces");
}
