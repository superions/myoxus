// SPDX-License-Identifier: AGPL-3.0-or-later

import { canUseServerBackedDatabases } from "../availability";
import { WorkspaceDialogService } from "@myoxus/core/modules/dialogs";
import { GraphQLService } from "@myoxus/core/modules/server/services/graphql";
import { WorkspaceService } from "@myoxus/core/modules/workspace/services/workspace";
import { DatabasePagesService } from "@myoxus/core/modules/workspace-pages/database-pages-service";
import {
  createDatabaseFromTemplateMutation,
  createDatabaseMutation,
  InitialDatabaseViewKind,
  ProjectOptionPreset,
  ProjectStructurePreset,
} from "@myoxus/graphql";
import { I18n } from "@myoxus/i18n";
import type { FrameworkProvider } from "@myoxus/infra";
import { notify } from "@myoxus/ui-facade";
import type {
  SlashMenuContext,
  SlashMenuItem,
} from "@virgultum/editor/widgets/slash-menu";
import { editorMessage } from "@virgultum/shared/services";

import { getPrimaryView } from "../model";

const databaseGroup = (itemOrder: number) => ({
  id: "database",
  label: editorMessage("com.myoxus.editor.group.database", "Database"),
  order: 7,
  itemOrder,
});

export type ServerDatabaseBlockReference = {
  databaseId: string;
  viewId?: string | null;
};

export function insertServerDatabaseBlockReference(
  { model, std }: SlashMenuContext,
  reference: ServerDatabaseBlockReference,
) {
  // Server-backed database blocks intentionally persist only references. The
  // renderer resolves schema, views, rows and cell values from GraphQL so Yjs
  // never becomes a stale secondary database source.
  const [blockId] = std.store.addSiblingBlocks(
    model,
    [
      {
        flavour: "myoxus:database" as const,
        serverDatabaseId: reference.databaseId,
        serverViewId: reference.viewId ?? null,
      },
    ],
    "after",
  );

  if (blockId && model.text?.length === 0) {
    std.store.deleteBlock(model);
  }

  return blockId ?? null;
}

async function createAndInsertServerDatabase(
  context: SlashMenuContext,
  framework: FrameworkProvider,
) {
  const workspaceId = framework.get(WorkspaceService).workspace.id;
  const graphQLService = framework.get(GraphQLService);
  const response = await graphQLService.gql({
    query: createDatabaseMutation,
    variables: {
      input: {
        initialViewKind: InitialDatabaseViewKind.Table,
        title: I18n["com.myoxus.database.create.table-title"](),
        workspaceId,
      },
    },
  });
  const record = response.createDatabase;
  framework.get(DatabasePagesService).invalidate();
  const view = getPrimaryView(record);

  insertServerDatabaseBlockReference(context, {
    databaseId: record.database.id,
    viewId: view.id,
  });
  notify.success({
    title: I18n["com.myoxus.database.slash.created"](),
  });
}

async function createAndInsertServerProject(
  context: SlashMenuContext,
  framework: FrameworkProvider,
) {
  const workspaceId = framework.get(WorkspaceService).workspace.id;
  const graphQLService = framework.get(GraphQLService);
  const response = await graphQLService.gql({
    query: createDatabaseFromTemplateMutation,
    variables: {
      input: {
        complexityPreset: ProjectOptionPreset.ThreeStep,
        includeSampleRows: false,
        priorityPreset: ProjectOptionPreset.ThreeStep,
        structurePreset: ProjectStructurePreset.Phases,
        templateId: "myoxus.project.simple_project",
        title: I18n["com.myoxus.database.create.project-title"](),
        workspaceId,
      },
    },
  });
  const record = response.createDatabaseFromTemplate;
  framework.get(DatabasePagesService).invalidate();
  const view = getPrimaryView(record);

  insertServerDatabaseBlockReference(context, {
    databaseId: record.database.id,
    viewId: view.id,
  });
  notify.success({
    title: I18n["com.myoxus.database.slash.created"](),
  });
}

function createServerTableItem(framework: FrameworkProvider): SlashMenuItem {
  return {
    id: "server-database-create-table",
    label: editorMessage(
      "com.myoxus.database.slash.new-table",
      "New server table",
    ),
    action: (context) => {
      void createAndInsertServerDatabase(context, framework).catch((error) => {
        console.error(error);
        notify.error({
          title: I18n["com.myoxus.database.slash.create-failed"](),
        });
      });
    },
    description: editorMessage(
      "com.myoxus.database.slash.new-table.description",
      "Create a database table on the server and embed it here.",
    ),
    group: databaseGroup(4),
    icon: "DatabaseTableViewIcon",
    searchAlias: [
      editorMessage("com.myoxus.database.slash.new-table", "New server table"),
    ],
  };
}

function createServerProjectItem(framework: FrameworkProvider): SlashMenuItem {
  return {
    id: "server-database-create-project",
    label: editorMessage(
      "com.myoxus.database.slash.new-project",
      "New server project",
    ),
    action: (context) => {
      void createAndInsertServerProject(context, framework).catch((error) => {
        console.error(error);
        notify.error({
          title: I18n["com.myoxus.database.slash.create-failed"](),
        });
      });
    },
    description: editorMessage(
      "com.myoxus.database.slash.new-project.description",
      "Create a server-backed project database and embed it here.",
    ),
    group: databaseGroup(5),
    icon: "DatabaseIcon",
    searchAlias: [
      editorMessage(
        "com.myoxus.database.slash.new-project",
        "New server project",
      ),
    ],
  };
}

export function createServerDatabaseSlashMenuItems(
  framework: FrameworkProvider,
): SlashMenuItem[] {
  const workspace = framework.get(WorkspaceService).workspace;
  if (!canUseServerBackedDatabases(workspace)) {
    return [];
  }

  return [
    {
      id: "server-database-embed-existing",
      label: editorMessage(
        "com.myoxus.database.slash.embed-existing",
        "Embed existing database",
      ),
      action: (context) => {
        // The command list disappears before the lazy selector mounts; retain its durable editor opener.
        const returnFocusRef = {
          current: document.activeElement as HTMLElement | null,
        };
        framework
          .get(WorkspaceDialogService)
          .open("database-selector", { init: [], returnFocusRef }, (result) => {
            if (!result) return;
            insertServerDatabaseBlockReference(context, result);
          });
      },
      description: editorMessage(
        "com.myoxus.database.slash.embed-existing.description",
        "Insert a server-backed database block.",
      ),
      group: databaseGroup(3),
      icon: "DatabaseIcon",
      searchAlias: [
        editorMessage(
          "com.myoxus.database.slash.embed-existing",
          "Embed existing database",
        ),
      ],
    },
    createServerTableItem(framework),
    createServerProjectItem(framework),
  ];
}
