import type { WorkspaceLabelExport } from "@myoxus/desktop-api-contract";
import { electronE2e } from "../../main/config";
import {
  loadDBFile,
  saveDBFileAs,
  selectDBFileLocation,
  setFakeDialogResult,
} from "./dialog";

export const dialogHandlers = {
  loadDBFile: async (dbFilePath?: string) => {
    return loadDBFile(dbFilePath);
  },
  saveDBFileAs: async (
    universalId: string,
    name: string,
    labels?: WorkspaceLabelExport,
  ) => {
    return saveDBFileAs(universalId, name, labels);
  },
  selectDBFileLocation: async () => {
    return selectDBFileLocation();
  },
  setFakeDialogResult: async (
    result: Parameters<typeof setFakeDialogResult>[0],
  ) => {
    if (!electronE2e) {
      throw new Error("Test dialog injection is unavailable in release builds");
    }
    return setFakeDialogResult(result);
  },
};
