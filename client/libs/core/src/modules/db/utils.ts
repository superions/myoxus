import type { DocStorage } from "@myoxus/storage";

import {
  Myoxus_WORKSPACE_DB_SCHEMA,
  Myoxus_WORKSPACE_USERDATA_DB_SCHEMA,
} from "./schema";

export async function transformWorkspaceDBLocalToCloud(
  _localWorkspaceId: string,
  _cloudWorkspaceId: string,
  localDocStorage: DocStorage,
  cloudDocStorage: DocStorage,
  accountId: string,
) {
  for (const tableName of Object.keys(Myoxus_WORKSPACE_DB_SCHEMA)) {
    const localDocName = `db$${tableName}`;
    const localDoc = await localDocStorage.getDoc(localDocName);
    if (localDoc) {
      const cloudDocName = `db$${tableName}`;
      await cloudDocStorage.pushDocUpdate({
        docId: cloudDocName,
        bin: localDoc.bin,
      });
    }
  }

  for (const tableName of Object.keys(Myoxus_WORKSPACE_USERDATA_DB_SCHEMA)) {
    const localDocName = `userdata$__local__$${tableName}`;
    const localDoc = await localDocStorage.getDoc(localDocName);
    if (localDoc) {
      const cloudDocName = `userdata$${accountId}$${tableName}`;
      await cloudDocStorage.pushDocUpdate({
        docId: cloudDocName,
        bin: localDoc.bin,
      });
    }
  }
}
