// SPDX-License-Identifier: AGPL-3.0-or-later
/** @vitest-environment happy-dom */

import "../test-editor-boundary";

import { DocsService } from "@myoxus/core/modules/doc";
import { GuardService } from "@myoxus/core/modules/permissions";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import { WorkbenchService } from "@myoxus/core/modules/workbench/services/workbench";
import {
  DatabaseTaskSourceState,
  databaseRowSourceQuery,
} from "@myoxus/graphql";
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import { TextSelection } from "@virgultum/editor/std";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import { SWRConfig } from "swr";
const fixture = vi.hoisted(() => ({
  owner: undefined as unknown,
  framework: undefined as unknown,
}));
vi.mock("../tasks/use-workspace-tasks", () => ({
  useTaskIdentity: () => fixture.owner,
}));
vi.mock("@myoxus/infra", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@myoxus/infra")>()),
  useFramework: () => fixture.framework,
}));
vi.mock("@myoxus/i18n", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@myoxus/i18n")>();
  const { createDatabaseTestI18nModule } = await import("../test-i18n-mock");
  return { ...actual, ...createDatabaseTestI18nModule() };
});
import { DatabaseRowSource } from "./row-source";
function setup() {
  const source = {
    sourceWorkspaceId: "workspace",
    documentId: "immutable-source",
    externalId: "source-key",
    title: "Private canonical source",
    blockId: "original-fragment",
    selectionAnchor: JSON.stringify({
      ...new TextSelection({
        from: { blockId: "original-fragment", index: 2, length: 4 },
        to: null,
      }).toJSON(),
      captureMode: "edgeless",
      noteId: "source-sticky",
    }),
    state: DatabaseTaskSourceState.Available,
  };
  const response = { workspace: { databaseRow: { row: { source } } } };
  const gql = vi.fn().mockResolvedValue(response);
  const server = {
    gql,
    id: "server",
    baseUrl: "https://myoxus.test",
    account$: { value: { id: "actor" } },
  };
  const owner = {
    server,
    account: server.account$.value,
    workspace: { id: "workspace" },
    identity: JSON.stringify([server.id, server.baseUrl, "actor", "workspace"]),
    availability: { status: "available" },
  };
  const note = { id: "source-sticky", flavour: "myoxus:note" };
  const fragment = {
    id: "original-fragment",
    flavour: "myoxus:paragraph",
    text: { length: 20 },
  };
  const getBlock = vi.fn((id: string) =>
    id === fragment.id ? { model: fragment } : null,
  );
  const getParent = vi.fn(() => note);
  const release = vi.fn();
  const waitForSyncReady = vi.fn(async (_signal: AbortSignal) => {});
  const open = vi.fn(() => ({
    doc: {
      waitForSyncReady,
      trash$: { value: false },
      primaryMode$: { value: "page" },
      virgultumDoc: { getBlock, getParent },
    },
    release,
  }));
  const can = vi.fn(async () => true);
  const openDoc = vi.fn();
  const waitForSynced = vi.fn(async (_key: string, _signal: AbortSignal) => {});
  const services = new Map<unknown, unknown>([
    [DocsService, { open }],
    [GuardService, { can }],
    [WorkbenchService, { workbench: { openDoc } }],
    [WorkspaceService, { workspace: { engine: { doc: { waitForSynced } } } }],
  ]);
  fixture.framework = { get: (id: unknown) => services.get(id) };
  fixture.owner = owner;
  const onOpenDoc = vi.fn();
  const props = {
    workspaceId: "workspace",
    databaseId: "project",
    rowId: "task",
    onOpenDoc,
  };
  const element = () => (
    <MyoxusUIProvider env="test">
      <SWRConfig value={{ shouldRetryOnError: false }}>
        <DatabaseRowSource {...props} />
      </SWRConfig>
    </MyoxusUIProvider>
  );
  return {
    source,
    response,
    server,
    owner,
    gql,
    can,
    open,
    openDoc,
    onOpenDoc,
    release,
    getBlock,
    getParent,
    waitForSyncReady,
    waitForSynced,
    element,
  };
}
afterEach(cleanup);

test("native source selection opens the original fragment through current SQL and guarded Doc readback", async () => {
  const f = setup();
  render(f.element());
  fireEvent.click(
    await screen.findByRole("button", { name: `Source · ${f.source.title}` }),
  );
  await waitFor(() =>
    expect(f.openDoc).toHaveBeenCalledWith({
      docId: "source-key",
      mode: "edgeless",
      blockIds: ["original-fragment"],
    }),
  );
  expect(f.gql).toHaveBeenCalledTimes(4);
  expect(
    f.gql.mock.calls.every(([input]) => input.query === databaseRowSourceQuery),
  ).toBe(true);
  expect(f.release).toHaveBeenCalledTimes(2);
  expect(f.onOpenDoc).not.toHaveBeenCalled();
});

test.each(["deleted"])(
  "a %s fragment has explicit missing feedback and opens only its authorized source document",
  async (condition) => {
    const f = setup();
    if (condition === "deleted") f.getBlock.mockReturnValue(null);
    else
      f.getParent.mockReturnValue({
        id: "different-note",
        flavour: "myoxus:note",
      });
    render(f.element());
    expect(
      (
        await screen.findByText(
          "The captured fragment is no longer available. Open the source document.",
        )
      ).textContent,
    ).toContain("fragment is no longer available");
    fireEvent.click(
      screen.getByRole("button", { name: `Source · ${f.source.title}` }),
    );
    await waitFor(() => expect(f.onOpenDoc).toHaveBeenCalledWith("source-key"));
    expect(f.openDoc).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledTimes(2);
  },
);

test("a warm source opening cannot expose a title or action when the same actor reopens after denial", async () => {
  const f = setup();
  const first = render(f.element());
  expect(
    (await screen.findByRole("button", { name: `Source · ${f.source.title}` }))
      .textContent,
  ).toBe(`Source · ${f.source.title}`);
  first.unmount();
  f.gql.mockRejectedValue(new Error("source access denied"));
  render(f.element());
  expect(screen.queryByText(f.source.title)).toBeNull();
  await screen.findByText("Unavailable");
  expect(screen.queryByRole("button")).toBeNull();
  expect(f.open).toHaveBeenCalledOnce();
});

test("actor change disposes and aborts the source Doc load; its late completion cannot publish a private title", async () => {
  const f = setup();
  let resolve!: () => void;
  f.waitForSyncReady.mockImplementationOnce(
    () =>
      new Promise<void>((done) => {
        resolve = done;
      }),
  );
  const view = render(f.element());
  await waitFor(() => expect(f.waitForSyncReady).toHaveBeenCalledOnce());
  const signal = f.waitForSyncReady.mock.calls[0][0];
  f.server.account$.value.id = "other-actor";
  fixture.owner = {
    ...f.owner,
    identity: JSON.stringify([
      f.server.id,
      f.server.baseUrl,
      "other-actor",
      "workspace",
    ]),
  };
  f.gql.mockResolvedValue({
    workspace: {
      databaseRow: {
        row: {
          source: { ...f.source, state: DatabaseTaskSourceState.Unavailable },
        },
      },
    },
  });
  view.rerender(f.element());
  await waitFor(() => expect(signal.aborted).toBe(true));
  expect(screen.queryByText(f.source.title)).toBeNull();
  await act(async () => {
    resolve();
    await Promise.resolve();
  });
  await waitFor(() => expect(f.release).toHaveBeenCalledOnce());
  expect(screen.queryByRole("button")).toBeNull();
});

test("source fragment inspection waits for current engine sync and uses the reconciled body", async () => {
  const f = setup();
  let synced!: () => void;
  f.waitForSynced.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        synced = resolve;
      }),
  );
  render(f.element());
  await waitFor(() => expect(f.waitForSynced).toHaveBeenCalledOnce());
  expect(screen.queryByText(f.source.title)).toBeNull();
  expect(f.getBlock).not.toHaveBeenCalled();
  f.getBlock.mockReturnValue(null);
  await act(async () => {
    synced();
  });
  await screen.findByText(
    "The captured fragment is no longer available. Open the source document.",
  );
  expect(
    screen.getByRole("button", { name: `Source · ${f.source.title}` })
      .textContent,
  ).toBe(`Source · ${f.source.title}`);
});
