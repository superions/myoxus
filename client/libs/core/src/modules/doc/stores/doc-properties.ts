import { LiveData, Store, yjsGetPath, yjsObserveDeep } from "@myoxus/infra";
import { isNil, omitBy } from "lodash-es";
import { combineLatest, map, of, switchMap } from "rxjs";
import { AbstractType as YAbstractType, encodeStateAsUpdate } from "yjs";

import type { WorkspaceDBService } from "../../db";
import type { DocProperties } from "../../db/schema/schema";
import type { WorkspaceService } from "../../workspace";

interface LegacyDocProperties {
  custom?: Record<string, { value: unknown } | undefined>;
  system?: Record<string, { value: unknown } | undefined>;
}

const RESERVED_SYSTEM_FACT_KEYS = new Set<keyof DocProperties>([
  "createdBy",
  "updatedBy",
]);

const RESERVED_SUBSYSTEM_KEYS = new Set<keyof DocProperties>([
  "journal",
  "isTemplate",
  "templateCategory",
  "templateTags",
  "primaryMode",
  "pageWidth",
  "edgelessColorTheme",
  "integrationType",
]);

type SubsystemProjection = Pick<
  DocProperties,
  | "journal"
  | "isTemplate"
  | "templateCategory"
  | "templateTags"
  | "primaryMode"
  | "pageWidth"
  | "edgelessColorTheme"
  | "integrationType"
>;

export class DocPropertiesStore extends Store {
  constructor(
    private readonly workspaceService: WorkspaceService,
    private readonly dbService: WorkspaceDBService,
  ) {
    super();
  }

  updateDocProperties(id: string, config: Partial<DocProperties>) {
    if (!this.isLocalWorkspace) return undefined;
    const safeConfig = this.omitReservedKeys(config);
    return this.dbService.db.docProperties.create({
      id,
      ...safeConfig,
    });
  }

  applyOfflineSubsystemProjection(
    id: string,
    projection: SubsystemProjection,
    awaitPersistence = false,
  ) {
    if (!this.isLocalWorkspace) {
      throw new Error(
        "Offline document properties are only available in local workspaces",
      );
    }
    const result = this.dbService.db.docProperties.create({
      id,
      ...projection,
    });
    if (!awaitPersistence) return result;
    // This table has its own storage document, separate from both the leaf and
    // workspace root. Save its complete real state even when retry changed no value.
    const doc = this.dbService.getWorkspaceDbDoc("docProperties");
    return this.workspaceService.workspace.engine.doc.saveCapturedUpdateAndWaitForSaved(
      doc.guid,
      encodeStateAsUpdate(doc),
    );
  }

  getDocProperties(id: string) {
    if (!this.isLocalWorkspace) return { id } as DocProperties;
    return {
      ...this.upgradeLegacyDocProperties(this.getLegacyDocProperties(id)),
      ...omitBy(this.dbService.db.docProperties.get(id), isNil),
      // db always override legacy, but nil value should not override
    };
  }

  watchDocProperties(id: string) {
    if (!this.isLocalWorkspace) return of({ id } as DocProperties);
    return combineLatest([
      this.watchLegacyDocProperties(id).pipe(
        map(this.upgradeLegacyDocProperties),
      ),
      this.dbService.db.docProperties.get$(id),
    ]).pipe(
      map(
        ([legacy, db]) =>
          ({
            ...legacy,
            ...omitBy(db, isNil), // db always override legacy, but nil value should not override
          }) as DocProperties,
      ),
    );
  }

  /**
   * find doc ids by property key and value
   *
   * this apis will not include legacy properties
   */
  watchPropertyAllValues(propertyKey: string) {
    if (!this.isLocalWorkspace) {
      return new LiveData<Map<string, string | undefined>>(new Map());
    }
    return LiveData.from<Map<string, string | undefined>>(
      this.dbService.db.docProperties
        .select$(propertyKey)
        .pipe(map((o) => new Map(o.map((i) => [i.id, i[propertyKey]])))),
      new Map(),
    );
  }

  private upgradeLegacyDocProperties(properties?: LegacyDocProperties) {
    if (!properties) {
      return {};
    }
    const newProperties: Record<string, string> = {};
    for (const [key, info] of Object.entries(properties.system ?? {})) {
      if (info?.value !== undefined && info.value !== null) {
        newProperties[key] = info.value.toString();
      }
    }
    for (const [key, info] of Object.entries(properties.custom ?? {})) {
      if (info?.value !== undefined && info.value !== null) {
        newProperties["custom:" + key] = info.value.toString();
      }
    }
    return newProperties;
  }

  private omitReservedKeys(config: Partial<DocProperties>) {
    return Object.fromEntries(
      Object.entries(config).filter(
        ([key]) =>
          !RESERVED_SYSTEM_FACT_KEYS.has(key as keyof DocProperties) &&
          !RESERVED_SUBSYSTEM_KEYS.has(key as keyof DocProperties),
      ),
    ) as Partial<DocProperties>;
  }

  private get isLocalWorkspace() {
    return this.workspaceService.workspace.flavour === "local";
  }

  private getLegacyDocProperties(id: string) {
    return this.workspaceService.workspace.rootYDoc
      .getMap<any>("myoxus:workspace-properties")
      .get("pageProperties")
      ?.get(id)
      ?.toJSON() as LegacyDocProperties | undefined;
  }

  private watchLegacyDocProperties(id: string) {
    return yjsGetPath(
      this.workspaceService.workspace.rootYDoc.getMap<any>(
        "myoxus:workspace-properties",
      ),
      `pageProperties.${id}`,
    ).pipe(
      switchMap(yjsObserveDeep),
      map(
        (p) =>
          (p instanceof YAbstractType ? p.toJSON() : p) as
            LegacyDocProperties | undefined,
      ),
    );
  }
}
