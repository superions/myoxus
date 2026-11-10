// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @vitest-environment happy-dom
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { WorkspaceDialogService } from "@myoxus/core/modules/dialogs";
import { GraphQLService } from "@myoxus/core/modules/server/services/graphql";
import { WorkspaceService } from "@myoxus/core/modules/workspace/services/workspace";
import { DatabasePagesService } from "@myoxus/core/modules/workspace-pages/database-pages-service";
import {
  InitialDatabaseViewKind,
  ProjectOptionPreset,
  ProjectStructurePreset,
} from "@myoxus/graphql";
import type { FrameworkProvider } from "@myoxus/infra";
import type { SlashMenuActionItem } from "@virgultum/editor/widgets/slash-menu";
import { describe, expect, type Mock, test, vi } from "vitest";

const notifySuccess = vi.hoisted(() => vi.fn());
const notifyError = vi.hoisted(() => vi.fn());

vi.mock("@myoxus/ui-facade", () => ({
  notify: {
    error: notifyError,
    success: notifySuccess,
  },
}));

import {
  createServerDatabaseSlashMenuItems,
  insertServerDatabaseBlockReference,
} from "./server-database-slash-menu";

function actionItem(item: unknown): SlashMenuActionItem {
  if (item && typeof item === "object" && "action" in item) {
    return item as SlashMenuActionItem;
  }
  throw new Error("Expected a slash menu action item.");
}

function createFramework({
  gql = vi.fn(),
  invalidate = vi.fn(),
  open = vi.fn(),
  workspace = { flavour: "myoxus-cloud", id: "ws-1" },
}: {
  gql?: Mock;
  invalidate?: Mock;
  open?: Mock;
  workspace?: { flavour?: string; id?: string };
} = {}) {
  const framework = {
    get(token: unknown) {
      if (token === GraphQLService) return { gql };
      if (token === DatabasePagesService) return { invalidate };
      if (token === WorkspaceDialogService) return { open };
      if (token === WorkspaceService) return { workspace };
      throw new Error(`Unexpected framework token: ${String(token)}`);
    },
  } as unknown as FrameworkProvider;

  return { framework, gql, invalidate, open };
}

function createSlashContext() {
  const addSiblingBlocks = vi.fn(
    (
      _target: unknown,
      _blocks: Array<Record<string, unknown>>,
      _place: "after",
    ) => ["block-1"],
  );
  const deleteBlock = vi.fn();
  const model = { text: { length: 0 } };
  const context = {
    model,
    std: {
      store: {
        addSiblingBlocks,
        deleteBlock,
      },
    },
  } as any;
  return { addSiblingBlocks, context, deleteBlock, model };
}

function firstInsertedBlockProps(
  addSiblingBlocks: ReturnType<typeof createSlashContext>["addSiblingBlocks"],
) {
  const insertedProps = addSiblingBlocks.mock.calls[0]?.[1]?.[0];
  expect(insertedProps).toBeTruthy();
  return insertedProps;
}

describe("server-backed database slash menu", () => {
  test("inserts only server database references into the editor block", () => {
    const { addSiblingBlocks, context, deleteBlock, model } =
      createSlashContext();

    const blockId = insertServerDatabaseBlockReference(context, {
      databaseId: "database-1",
      viewId: "view-1",
    });

    expect(blockId).toBe("block-1");
    expect(addSiblingBlocks).toHaveBeenCalledWith(
      model,
      [
        {
          flavour: "myoxus:database",
          serverDatabaseId: "database-1",
          serverViewId: "view-1",
        },
      ],
      "after",
    );
    const insertedProps = firstInsertedBlockProps(addSiblingBlocks);
    expect(insertedProps).not.toHaveProperty("cells");
    expect(insertedProps).not.toHaveProperty("columns");
    expect(insertedProps).not.toHaveProperty("views");
    expect(deleteBlock).toHaveBeenCalledWith(model);
  });

  test("opens the database selector for existing server databases", () => {
    let callback:
      | ((result?: { databaseId: string; viewId?: string | null }) => void)
      | undefined;
    const open = vi.fn((_type, _props, cb) => {
      callback = cb;
      return "dialog-1";
    });
    const { framework } = createFramework({ open });
    const { addSiblingBlocks, context } = createSlashContext();
    const embedExisting = createServerDatabaseSlashMenuItems(framework).find(
      (item) => item.id === "server-database-embed-existing",
    );

    actionItem(embedExisting).action(context);
    callback?.({ databaseId: "database-existing", viewId: "view-existing" });

    expect(open).toHaveBeenCalledWith(
      "database-selector",
      { init: [], returnFocusRef: { current: document.activeElement } },
      expect.any(Function),
    );
    expect(firstInsertedBlockProps(addSiblingBlocks)).toMatchObject({
      flavour: "myoxus:database",
      serverDatabaseId: "database-existing",
      serverViewId: "view-existing",
    });
  });

  test("omits server database slash actions for local workspaces before GraphQL or dialogs can run", () => {
    const { framework, gql, open } = createFramework({
      workspace: { flavour: "local", id: "local-1" },
    });

    expect(createServerDatabaseSlashMenuItems(framework)).toEqual([]);
    expect(gql).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  test("creates a server database before embedding a new table block", async () => {
    const gql = vi.fn().mockResolvedValue({
      createDatabase: {
        database: {
          id: "database-new",
          title: "New table",
          workspaceId: "ws-1",
        },
        fields: [],
        rowCount: 0,
        views: [
          {
            id: "view-new",
            position: 0,
          },
        ],
      },
    });
    const { framework, invalidate } = createFramework({ gql });
    const { addSiblingBlocks, context } = createSlashContext();
    const newTable = createServerDatabaseSlashMenuItems(framework).find(
      (item) => item.id === "server-database-create-table",
    );

    actionItem(newTable).action(context);

    await vi.waitFor(() => {
      expect(addSiblingBlocks).toHaveBeenCalled();
    });
    expect(gql).toHaveBeenCalledWith(
      expect.objectContaining({
        variables: {
          input: expect.objectContaining({
            initialViewKind: InitialDatabaseViewKind.Table,
            workspaceId: "ws-1",
          }),
        },
      }),
    );
    expect(firstInsertedBlockProps(addSiblingBlocks)).toMatchObject({
      flavour: "myoxus:database",
      serverDatabaseId: "database-new",
      serverViewId: "view-new",
    });
    expect(notifySuccess).toHaveBeenCalled();
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  test("creates a server project before embedding a new project block", async () => {
    const gql = vi.fn().mockResolvedValue({
      createDatabaseFromTemplate: {
        database: {
          id: "project-new",
          title: "Untitled project",
          workspaceId: "ws-1",
        },
        fields: [],
        rowCount: 0,
        views: [
          {
            id: "project-view",
            position: 0,
          },
        ],
      },
    });
    const { framework, invalidate } = createFramework({ gql });
    const { addSiblingBlocks, context } = createSlashContext();
    const newProject = createServerDatabaseSlashMenuItems(framework).find(
      (item) => item.id === "server-database-create-project",
    );

    actionItem(newProject).action(context);

    await vi.waitFor(() => {
      expect(addSiblingBlocks).toHaveBeenCalled();
    });
    expect(gql).toHaveBeenCalledWith(
      expect.objectContaining({
        variables: {
          input: expect.objectContaining({
            complexityPreset: ProjectOptionPreset.ThreeStep,
            includeSampleRows: false,
            priorityPreset: ProjectOptionPreset.ThreeStep,
            structurePreset: ProjectStructurePreset.Phases,
            templateId: "myoxus.project.simple_project",
            workspaceId: "ws-1",
          }),
        },
      }),
    );
    expect(firstInsertedBlockProps(addSiblingBlocks)).toMatchObject({
      flavour: "myoxus:database",
      serverDatabaseId: "project-new",
      serverViewId: "project-view",
    });
    expect(notifySuccess).toHaveBeenCalled();
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  test("does not expose Kanban as a new product creation entry", () => {
    const source = readFileSync(
      join(
        process.cwd(),
        "client/libs/core/src/modules/database/database-block-adapter/server-database-slash-menu.ts",
      ),
      "utf8",
    );

    expect(source).toContain("createDatabaseFromTemplateMutation");
    expect(source).toContain("com.myoxus.database.slash.new-project");
    expect(source).not.toContain("com.myoxus.database.slash.new-kanban");
    expect(source).not.toContain("DatabaseKanbanViewIcon");
  });

  test("keeps the database selector registered in the workspace dialog registry", () => {
    const dialogs = readFileSync(
      join(process.cwd(), "client/libs/core/src/desktop/dialogs/workspace.tsx"),
      "utf8",
    );
    const schema = readFileSync(
      join(process.cwd(), "client/libs/core/src/modules/dialogs/constant.ts"),
      "utf8",
    );

    expect(schema).toContain('"database-selector"');
    expect(dialogs).toContain("DatabaseSelectorDialog");
    expect(dialogs).toContain('"database-selector"');
  });

  test("keeps server embeds on the Core GraphQL adapter behind the reference-only Virgultum shell", () => {
    const serverBlock = readFileSync(
      join(
        process.cwd(),
        "client/libs/core/src/modules/database/database-block-adapter/server-database-block.tsx",
      ),
      "utf8",
    );
    const virgultumBlock = readFileSync(
      join(
        process.cwd(),
        "virgultum/editor/blocks/database/src/reference-database-block.ts",
      ),
      "utf8",
    );
    const manager = readFileSync(
      join(process.cwd(), "client/libs/core/src/editor/manager/view.ts"),
      "utf8",
    );

    expect(serverBlock).toContain("GraphQLService");
    expect(serverBlock).toContain("databaseSchemaQuery");
    expect(serverBlock).toContain("databaseViewsQuery");
    expect(serverBlock).toContain("databaseViewQuery");
    expect(serverBlock).toContain("databaseRowsQuery");
    expect(serverBlock).toContain("MyoxusEmbeddedUIProvider");
    expect(serverBlock).toContain(
      "getRootElement={this.getMantineRootElement}",
    );
    expect(serverBlock).not.toContain("<MyoxusUIProvider");
    expect(serverBlock).not.toContain("DatabaseBlockDataSource");
    const renderBlockBody = virgultumBlock.slice(
      virgultumBlock.indexOf("override renderBlock()"),
    );
    expect(renderBlockBody).toContain("this.model.props.serverDatabaseId");
    expect(renderBlockBody).toContain("renderServerDatabase");
    expect(renderBlockBody).not.toMatch(/\.props\.(cells|columns|views)/);
    expect(renderBlockBody).not.toContain("DatabaseBlockDataSource");
    expect(manager).toContain("DatabaseReferenceViewExtension");
    expect(manager).not.toContain("DatabaseViewExtension");
    expect(manager).not.toContain("MyoxusDatabaseViewExtension");
  });
});
