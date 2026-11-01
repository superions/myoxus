import {
  BlockModel,
  BlockSchemaExtension,
  defineBlockSchema,
} from "@virgultum/store";

/** Persisted editor shell for a server-owned Database and optional view. */
export type DatabaseBlockProps = {
  serverDatabaseId?: string;
  serverWorkspaceId?: string;
  serverRowId?: string;
  serverViewId?: string | null;
  /** Compact references never mount the embedded Database editor. */
  serverReferencePresentation?: "compact";
  /** Source-only slot, bound or removed by native template instantiation. */
  templateReference?: {
    key: "context.container" | "context.task";
    kind: "database" | "task";
    optional: true;
  };
};

export class DatabaseBlockModel extends BlockModel<DatabaseBlockProps> {}

export const DatabaseBlockSchema = defineBlockSchema({
  flavour: "myoxus:database",
  props: (): DatabaseBlockProps => ({
    serverDatabaseId: undefined,
    serverWorkspaceId: undefined,
    serverRowId: undefined,
    serverViewId: null,
    serverReferencePresentation: undefined,
    templateReference: undefined,
  }),
  metadata: {
    role: "hub",
    version: 3,
    parent: ["myoxus:note"],
    children: [],
  },
  toModel: () => new DatabaseBlockModel(),
});

export const DatabaseBlockSchemaExtension =
  BlockSchemaExtension(DatabaseBlockSchema);
