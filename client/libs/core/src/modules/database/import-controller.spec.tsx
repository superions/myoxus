// SPDX-License-Identifier: AGPL-3.0-or-later
/** @vitest-environment happy-dom */

import { GraphQLService } from "@myoxus/core/modules/server/services/graphql";
import {
  importDatabaseJsonMutation,
  DatabaseJsonImportModeType,
  DatabaseJsonConflictStrategyType,
  previewDatabaseJsonImportMutation,
} from "@myoxus/graphql";
import { FrameworkRoot, type FrameworkProvider } from "@myoxus/infra";
import { notify } from "@myoxus/ui-facade";
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { SWRConfig } from "swr";

import { useDatabaseImportController } from "./import-controller";
import { record } from "./test-fixtures";

vi.mock("@myoxus/i18n", async () => {
  const { createDatabaseTestI18nModule } = await import("./test-i18n-mock");
  return createDatabaseTestI18nModule();
});

afterEach(() => {
  cleanup();
  notify.dismiss();
  vi.restoreAllMocks();
});

test.each([["Parent", true, false]] as const)(
  "JSON %s diagnostics use localized policy/loss copy and respect preview blocking=%s, omitted=%s",
  async () => {
    const lossMessage =
      "Unavailable parent links were omitted from this export.";
    const graphMessage = "This parent would create a cycle.";
    const loss = {
      code: "MIX_DATABASE_JSON_PARENT_TARGET_OMITTED",
      message: "Server-only loss diagnostic",
      path: null,
    };
    const gql = vi.fn(async ({ query }: { query?: unknown }) => {
      if (query === previewDatabaseJsonImportMutation)
        return {
          previewDatabaseJsonImport: {
            schemaVersion: 1,
            title: "Imported Project",
            fieldCount: 1,
            viewCount: 1,
            rowCount: 2,
            templateCount: 0,
            errors: [
              {
                code: "MIX_DATABASE_TASK_RELATION_INVALID_Cycle",
                message: "Server-only graph diagnostic",
                path: null,
              },
            ],
            warnings: [
              loss,
              {
                code: "MIX_DATABASE_TASK_RELATION_INVALID_FutureReason",
                message: "Unknown reason keeps its server message",
                path: null,
              },
            ],
            workspaceTagDiagnostics: [],
          },
        };
      if (query === importDatabaseJsonMutation)
        return { importDatabaseJson: { database: record, warnings: [loss] } };
      throw new Error("Unexpected import operation");
    });
    const graphqlService = { gql };
    const framework = {
      get(token: unknown) {
        if (token === GraphQLService) return graphqlService;
        throw new Error(`Unexpected import service: ${String(token)}`);
      },
    } as unknown as FrameworkProvider;
    const imported = vi.fn();
    function Consumer() {
      const controller = useDatabaseImportController({
        workspaceId: "workspace-1",
        onImported: imported,
      });
      return controller.surfaces;
    }
    render(
      <SWRConfig value={{ provider: () => new Map() }}>
        <FrameworkRoot framework={framework}>
          <MyoxusUIProvider env="test">
            <Consumer />
          </MyoxusUIProvider>
        </FrameworkRoot>
      </SWRConfig>,
    );
    fireEvent.change(screen.getByTestId("database-json-file-input"), {
      target: { files: [new File(["{}"], "project.json")] },
    });
    const modal = await screen.findByRole("dialog", {
      name: "Import JSON snapshot",
    });
    expect(within(modal).getByText(lossMessage).textContent).toBe(lossMessage);
    expect(
      within(modal).getByText("Unknown reason keeps its server message")
        .textContent,
    ).toBe("Unknown reason keeps its server message");
    expect(within(modal).queryByText("Server-only loss diagnostic")).toBeNull();
    const apply = within(modal).getByRole("button", {
      name: "Import snapshot",
    });
    expect((apply as HTMLButtonElement).disabled).toBe(true);
    expect(within(modal).getByText(graphMessage).textContent).toBe(
      graphMessage,
    );
    expect(
      within(modal).queryByText("Server-only graph diagnostic"),
    ).toBeNull();
    await userEvent.setup().click(apply);
    expect(imported).not.toHaveBeenCalled();
    expect(
      gql.mock.calls.filter(
        ([request]) => request.query === importDatabaseJsonMutation,
      ),
    ).toHaveLength(0);
  },
);

test.each([false, true])(
  "managed JSON content import previews an exact Merge target and writes only after confirmation (cancel=%s)",
  async (cancel) => {
    const gql = vi.fn(
      async ({ query }: { query: unknown; variables: unknown }) => {
        if (query === previewDatabaseJsonImportMutation)
          return {
            previewDatabaseJsonImport: {
              schemaVersion: 1,
              title: "Imported content",
              fieldCount: 2,
              viewCount: 1,
              rowCount: 2,
              templateCount: 0,
              errors: [],
              warnings: [],
              workspaceTagDiagnostics: [],
            },
          };
        if (query === importDatabaseJsonMutation)
          return { importDatabaseJson: { database: record, warnings: [] } };
        throw new Error("Unexpected content import operation");
      },
    );
    const framework = {
      get: (token: unknown) => {
        if (token === GraphQLService) return { gql };
        throw new Error(`Unexpected service ${String(token)}`);
      },
    } as unknown as FrameworkProvider;
    const imported = vi.fn();
    function Consumer() {
      const controller = useDatabaseImportController({
        workspaceId: "workspace-1",
        targetDatabaseId: record.database.id,
        targetDatabaseTitle: "Workspace Tasks",
        onImported: imported,
      });
      return controller.surfaces;
    }
    render(
      <SWRConfig value={{ provider: () => new Map() }}>
        <FrameworkRoot framework={framework}>
          <MyoxusUIProvider env="test">
            <Consumer />
          </MyoxusUIProvider>
        </FrameworkRoot>
      </SWRConfig>,
    );
    fireEvent.change(screen.getByTestId("database-json-file-input"), {
      target: { files: [new File(["{}"], "tasks.json")] },
    });
    const modal = await screen.findByTestId("database-json-import-modal");
    expect(await within(modal).findByText("Workspace Tasks")).not.toBeNull();
    expect(
      within(modal).getByText("Merge into an existing database"),
    ).not.toBeNull();
    const input = {
      workspaceId: "workspace-1",
      targetDatabaseId: record.database.id,
      mode: DatabaseJsonImportModeType.MERGE,
      conflictStrategy: DatabaseJsonConflictStrategyType.ABORT,
    };
    expect(
      gql.mock.calls.filter(
        ([request]) => request.query === previewDatabaseJsonImportMutation,
      )[0][0].variables,
    ).toMatchObject({ input });
    expect(
      gql.mock.calls.filter(
        ([request]) => request.query === importDatabaseJsonMutation,
      ),
    ).toHaveLength(0);
    await userEvent.setup().click(
      within(modal).getByRole("button", {
        name: cancel ? "Cancel" : "Import snapshot",
      }),
    );
    if (cancel) {
      expect(
        gql.mock.calls.filter(
          ([request]) => request.query === importDatabaseJsonMutation,
        ),
      ).toHaveLength(0);
      expect(imported).not.toHaveBeenCalled();
    } else {
      await waitFor(() =>
        expect(imported).toHaveBeenCalledWith(
          record.database.id,
          record.views[0]!.id,
        ),
      );
      expect(
        gql.mock.calls.filter(
          ([request]) => request.query === importDatabaseJsonMutation,
        )[0][0].variables,
      ).toMatchObject({ input });
    }
  },
);
