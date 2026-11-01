import {
  createORMClient,
  LiveData,
  ObjectPool,
  Service,
  YjsDBAdapter,
} from "@myoxus/infra";
import { Doc as YDoc } from "yjs";

import type { WorkspaceServerService } from "../../server";
import { AuthService } from "../../server/services/auth";
import type { WorkspaceService } from "../../workspace";
import { WorkspaceDB, type WorkspaceDBWithTables } from "../entities/db";
import {
  Myoxus_WORKSPACE_DB_SCHEMA,
  Myoxus_WORKSPACE_USERDATA_DB_SCHEMA,
  type MyoxusWorkspaceDbSchema,
  type MyoxusWorkspaceUserdataDbSchema,
} from "../schema";

const WorkspaceDBClient = createORMClient(Myoxus_WORKSPACE_DB_SCHEMA);
const WorkspaceUserdataDBClient = createORMClient(
  Myoxus_WORKSPACE_USERDATA_DB_SCHEMA,
);

export class WorkspaceDBService extends Service {
  db: WorkspaceDBWithTables<MyoxusWorkspaceDbSchema>;
  private readonly workspaceDbDocs = new Map<
    keyof MyoxusWorkspaceDbSchema & string,
    YDoc
  >();
  userdataDBPool = new ObjectPool<
    string,
    WorkspaceDB<MyoxusWorkspaceUserdataDbSchema>
  >({
    onDangling() {
      return false; // never release
    },
  });

  constructor(
    private readonly workspaceService: WorkspaceService,
    private readonly workspaceServerService: WorkspaceServerService,
  ) {
    super();
    this.db = this.framework.createEntity(
      WorkspaceDB<MyoxusWorkspaceDbSchema>,
      {
        db: new WorkspaceDBClient(
          new YjsDBAdapter(Myoxus_WORKSPACE_DB_SCHEMA, {
            getDoc: (guid) =>
              this.getWorkspaceDbDoc(
                guid as keyof MyoxusWorkspaceDbSchema & string,
              ),
          }),
        ),
        schema: Myoxus_WORKSPACE_DB_SCHEMA,
        storageDocId: (tableName) => `db$${tableName}`,
      },
    ) as WorkspaceDBWithTables<MyoxusWorkspaceDbSchema>;
  }

  userdataDB(userId: (string & {}) | "__local__") {
    // __local__ for local workspace
    const userdataDb = this.userdataDBPool.get(userId);
    if (userdataDb) {
      return userdataDb.obj as WorkspaceDBWithTables<MyoxusWorkspaceUserdataDbSchema>;
    }

    const newDB = this.framework.createEntity(
      WorkspaceDB<MyoxusWorkspaceUserdataDbSchema>,
      {
        db: new WorkspaceUserdataDBClient(
          new YjsDBAdapter(Myoxus_WORKSPACE_USERDATA_DB_SCHEMA, {
            getDoc: (guid) => {
              const ydoc = new YDoc({
                // guid format: userdata${userId}${guid}
                guid: `userdata$${userId}$${guid}`,
              });
              this.workspaceService.workspace.engine.doc.connectDoc(ydoc);
              this.workspaceService.workspace.engine.doc.addPriority(
                ydoc.guid,
                50,
              );
              return ydoc;
            },
          }),
        ),
        schema: Myoxus_WORKSPACE_USERDATA_DB_SCHEMA,
        storageDocId: (tableName) => `userdata$${userId}$${tableName}`,
      },
    );

    this.userdataDBPool.put(userId, newDB);
    return newDB as WorkspaceDBWithTables<MyoxusWorkspaceUserdataDbSchema>;
  }

  /**
   * Returns the canonical Y.Doc backing one workspace DB table.
   *
   * Most callers should use the typed ORM table APIs exposed through `db`.
   * Cross-runtime metadata that must be stored next to ORM rows, such as the
   * MCP folder-row index, needs this exact document so it is synced with the
   * same storage id (`db$<tableName>`) as the table rows themselves.
   */
  getWorkspaceDbDoc(tableName: keyof MyoxusWorkspaceDbSchema & string) {
    const existing = this.workspaceDbDocs.get(tableName);
    if (existing) {
      return existing;
    }

    if (!(tableName in Myoxus_WORKSPACE_DB_SCHEMA)) {
      throw new Error(`Unknown workspace DB table: ${tableName}`);
    }

    const ydoc = new YDoc({
      // guid format: db${tableName}
      guid: `db$${tableName}`,
    });
    this.workspaceService.workspace.engine.doc.connectDoc(ydoc);
    this.workspaceService.workspace.engine.doc.addPriority(ydoc.guid, 50);
    this.workspaceDbDocs.set(tableName, ydoc);
    return ydoc;
  }

  authService = this.workspaceServerService.server?.scope.get(AuthService);
  public get userdataDB$() {
    // if is local workspace or no account, use __local__ userdata
    // sometimes we may have cloud workspace but no account for a short time, we also use __local__ userdata
    if (
      this.workspaceService.workspace.meta.flavour === "local" ||
      !this.authService
    ) {
      return new LiveData(this.userdataDB("__local__"));
    } else {
      return this.authService.session.account$.map((account) => {
        if (!account) {
          return this.userdataDB("__local__");
        }
        return this.userdataDB(account.id);
      });
    }
  }

  static isDBDocId(docId: string) {
    return docId.startsWith("db$") || docId.startsWith("userdata$");
  }
}
