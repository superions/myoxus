// SPDX-License-Identifier: AGPL-3.0-or-later
/** @vitest-environment happy-dom */

import { createRef } from "react";

import {
  DatabaseTaskCaptureState,
  DatabaseTaskSourceState,
  type DatabaseTaskCaptureResultFragment,
} from "@myoxus/graphql";

import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  identity: "server/actor-a/workspace",
  close: vi.fn(),
  capture: {
    phase: "draft",
    result: null as DatabaseTaskCaptureResultFragment | null,
    retained: undefined as
      | {
          input: {
            sourceDocumentId: string;
            sourceExternalId: string;
            blockId: string;
            selectionAnchor?: string | null;
            title: string;
            databaseId: string;
            cells: [];
          };
          excerpt: string;
        }
      | undefined,
    release: vi.fn(),
    retainForReferenceRecovery: vi.fn(),
  },
}));
vi.mock("./use-workspace-tasks", () => ({
  useTaskIdentity: () => ({
    identity: fixture.identity,
    server: { gql: vi.fn() },
    account: { id: fixture.identity },
    workspace: { id: "workspace" },
    availability: { status: "available" },
  }),
  useTaskDestinations: () => ({
    readyDestinations: [],
    projects: [],
    defaultDestination: null,
    unavailableProjects: [],
    coverageComplete: true,
    nextCursor: null,
    destinationError: null,
    isLoading: false,
    error: null,
    mutate: vi.fn(),
  }),
}));
vi.mock("../presentation/use-assistant-presentation", async () => {
  const { assistantPackagesFixture } =
    await import("../presentation/test-fixtures");
  return {
    useAssistantPresentation: (
      context: import("@myoxus/graphql").AssistantContext,
    ) => ({
      descriptor: assistantPackagesFixture(context)[0],
      invalidated: false,
      mutate: vi.fn(),
    }),
  };
});
vi.mock("./use-capture-task", () => ({
  useCaptureTask: () => ({
    ...fixture.capture,
    draft: undefined,
    failure: null,
  }),
}));
vi.mock("@myoxus/infra", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@myoxus/infra")>()),
  useService: () => ({ workbench: { open: vi.fn() } }),
}));
vi.mock("@myoxus/i18n", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@myoxus/i18n")>();
  const { createDatabaseTestI18nModule } = await import("../test-i18n-mock");
  return { ...actual, ...createDatabaseTestI18nModule() };
});
import { TaskCaptureDialog } from "./task-capture-dialog";
import { TaskCardCreate } from "./task-card-create";

afterEach(cleanup);
beforeEach(() => {
  fixture.identity = "server/actor-a/workspace";
  fixture.close.mockClear();
  fixture.capture.release.mockClear();
  fixture.capture.retainForReferenceRecovery.mockClear();
  fixture.capture.phase = "draft";
  fixture.capture.result = null;
  fixture.capture.retained = undefined;
});
function committed() {
  fixture.capture.phase = "confirmed";
  fixture.capture.result = {
    requestId: "committed-request",
    databaseId: "project",
    rowId: "canonical-row",
    editRevision: 1,
    state: DatabaseTaskCaptureState.Available,
    replayed: true,
    record: null,
    source: {
      sourceWorkspaceId: "workspace",
      documentId: "immutable-doc-uuid",
      externalId: "source-key",
      blockId: "original-checkbox",
      selectionAnchor: null,
      state: DatabaseTaskSourceState.Available,
      title: "Source",
    },
  };
  fixture.capture.retained = {
    input: {
      sourceDocumentId: "immutable-doc-uuid",
      sourceExternalId: "source-key",
      blockId: "original-checkbox",
      selectionAnchor: null,
      title: "Frozen Task title",
      databaseId: "project",
      cells: [],
    },
    excerpt: "Original immutable text",
  };
}

it.each([null])(
  "preserves a retained whole-block anchor (%s) despite a different reopened selection",
  async (originalAnchor) => {
    committed();
    fixture.capture.retained!.input.selectionAnchor = originalAnchor;
    const insert = vi
      .fn()
      .mockResolvedValueOnce("uncertain")
      .mockResolvedValueOnce("inserted");
    render(
      <MyoxusUIProvider env="test">
        <TaskCaptureDialog
          sourceDocumentId="immutable-doc-uuid"
          sourceExternalId="source-key"
          blockId="different-current-selection"
          selectionAnchor={
            ' {"from":{"blockId":"unrelated-block","index":0,"length":2}}'
          }
          excerpt="Different current text"
          openingOwnerIdentity={fixture.identity}
          close={fixture.close}
          onInsertReference={insert}
        />
      </MyoxusUIProvider>,
    );
    const retry = await screen.findByRole("button", {
      name: "Insert reference",
    });
    const expected = [
      "committed-request",
      {
        workspaceId: "workspace",
        databaseId: "project",
        rowId: "canonical-row",
      },
      {
        sourceDocumentId: "immutable-doc-uuid",
        sourceExternalId: "source-key",
        blockId: "original-checkbox",
        selectionAnchor: originalAnchor,
      },
    ];
    expect(insert.mock.calls[0]).toEqual(expected);
    fireEvent.click(retry);
    await waitFor(() => expect(insert).toHaveBeenCalledTimes(2));
    expect(insert.mock.calls[1]).toEqual(expected);
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Insert reference" }),
      ).toBeNull(),
    );
    expect(screen.getByRole("button", { name: "Open task" }).textContent).toBe(
      "Open task",
    );
  },
);

it("retains the inline card's capture identity after uncertain insertion dismissal", async () => {
  committed();
  const anchor = render(<div />).container.firstElementChild as HTMLElement;
  render(
    <MyoxusUIProvider env="test">
      <TaskCardCreate
        anchor={anchor}
        source={fixture.capture.retained!.input}
        openingOwnerIdentity={fixture.identity}
        isCurrent={() => true}
        close={fixture.close}
        onInsertReference={vi.fn().mockResolvedValue("uncertain")}
        onInserted={vi.fn()}
      />
    </MyoxusUIProvider>,
  );
  await screen.findByRole("button", { name: "Insert reference" });
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  await waitFor(() => expect(fixture.close).toHaveBeenCalledOnce());
  expect(fixture.capture.retainForReferenceRecovery).toHaveBeenCalledOnce();
  expect(fixture.capture.release).not.toHaveBeenCalled();
});

it("keeps committed capture recovery on failed insertion dismissal and offers only Task/copy after readonly capture", async () => {
  committed();
  const opener = createRef<HTMLButtonElement>();
  const retain = fixture.capture.retainForReferenceRecovery;
  const view = render(
    <MyoxusUIProvider env="test">
      <button ref={opener}>Editor</button>
      <TaskCaptureDialog
        returnFocusRef={opener}
        sourceDocumentId="immutable-doc-uuid"
        sourceExternalId="source-key"
        blockId="original-checkbox"
        excerpt="Text"
        openingOwnerIdentity={fixture.identity}
        close={fixture.close}
        onInsertReference={vi.fn().mockResolvedValue("failed")}
      />
    </MyoxusUIProvider>,
  );
  await screen.findByRole("button", { name: "Insert reference" });
  const failedDialog = screen.getByRole("dialog", { name: "Capture as Task" });
  // Select the visible footer action rather than the separate icon close control.
  fireEvent.click(within(failedDialog).getByText("Close"));
  await waitFor(() => expect(fixture.close).toHaveBeenCalledOnce());
  expect(document.activeElement).toBe(opener.current);
  expect(retain).toHaveBeenCalledOnce();
  expect(fixture.capture.release).not.toHaveBeenCalled();
  view.unmount();
  fixture.close.mockClear();
  render(
    <MyoxusUIProvider env="test">
      <TaskCaptureDialog
        sourceDocumentId="immutable-doc-uuid"
        sourceExternalId="source-key"
        blockId="original-checkbox"
        excerpt="Text"
        openingOwnerIdentity={fixture.identity}
        close={fixture.close}
        onInsertReference={vi.fn().mockResolvedValue("readonly")}
      />
    </MyoxusUIProvider>,
  );
  await waitFor(() =>
    expect(
      within(screen.getByRole("dialog", { name: "Capture as Task" }))
        .getByText("Close")
        .closest("button"),
    ).toHaveProperty("disabled", false),
  );
  expect(screen.queryByRole("button", { name: "Insert reference" })).toBeNull();
  expect(screen.getByRole("button", { name: "Open task" }).textContent).toBe(
    "Open task",
  );
  expect(screen.getByRole("button", { name: "Copy link" }).textContent).toBe(
    "Copy link",
  );
});

it("hides the opening actor's excerpt and actions immediately when owner identity changes", () => {
  const props = {
    openingOwnerIdentity: fixture.identity,
    sourceDocumentId: "immutable-doc-uuid",
    sourceExternalId: "source-key",
    blockId: "paragraph",
    excerpt: "Private opening actor excerpt",
    close: fixture.close,
  };
  const view = render(
    <MyoxusUIProvider env="test">
      <TaskCaptureDialog {...props} />
    </MyoxusUIProvider>,
  );
  expect(
    (
      screen.getByRole("textbox", {
        name: "Description (optional)",
      }) as HTMLTextAreaElement
    ).value,
  ).toBe(props.excerpt);
  fixture.identity = "server/actor-b/workspace";
  view.rerender(
    <MyoxusUIProvider env="test">
      <TaskCaptureDialog {...props} />
    </MyoxusUIProvider>,
  );
  expect(
    screen.queryByDisplayValue("Private opening actor excerpt"),
  ).toBeNull();
  expect(screen.queryByTestId("task-capture-modal")).toBeNull();
  expect(fixture.close).toHaveBeenCalledOnce();
});
