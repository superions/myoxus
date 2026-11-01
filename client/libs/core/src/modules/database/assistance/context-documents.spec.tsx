// SPDX-License-Identifier: AGPL-3.0-or-later
/** @vitest-environment happy-dom */
import "../test-editor-boundary";

import {
  AssistantContext,
  AssistantFolderDestinationKind,
  AssistantValueType,
  AssistanceMode,
  AssistanceSource,
  ProjectSetupStatus,
  assistantPackagesQuery,
  prepareContextDocumentsQuery,
  contextDocumentsQuery,
  applyContextDocumentsMutation,
  stopContextDocumentsMutation,
  type PrepareContextDocumentsInput,
  type PreparedContextDocumentsFragmentFragment,
  type ContextDocumentsFragmentFragment,
} from "@myoxus/graphql";
import { GlobalState } from "@myoxus/core/modules/storage";
import { GraphQLError } from "@myoxus/error";
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import { Button } from "@myoxus/ui-facade";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { SWRConfig } from "swr";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
  vi,
} from "vitest";
import { assistantPackagesFixture } from "../presentation/test-fixtures";
import { assistantValue } from "../presentation/values";
import {
  ContextDocumentAssistance,
  ContextDocumentTaskMenu,
} from "./context-documents";
import {
  contextDocumentsAttemptKey,
  type ContextDocumentsAttempt,
} from "./context-documents-attempt";

const fixture = vi.hoisted(() => ({
  gql: vi.fn(),
  persist: vi.fn(),
  read: vi.fn(),
  preferences: vi.fn(),
  open: vi.fn(),
  storage: new Map<string, ContextDocumentsAttempt>(),
  account: null as { next: (value: { id: string } | null) => void } | null,
}));
vi.mock("@myoxus/i18n", async () =>
  (await import("../test-i18n-mock")).createDatabaseTestI18nModule(),
);
vi.mock("@myoxus/core/components/hooks/myoxus/use-user-preferences", () => ({
  useRegionalPreferences: () => ({
    locale: "en",
    timezone: "Pacific/Honolulu",
    dateFormat: "year-month-day",
    timeFormat: "24-hour",
  }),
}));
vi.mock("@myoxus/infra", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@myoxus/infra")>();
  const { Observable, Subject } = await import("rxjs");
  const storageChanges = new Subject<string>();
  const root = { sortedChildren$: new actual.LiveData([]) };
  const search = {
    result$: new actual.LiveData([]),
    reset: vi.fn(),
    loadMore: vi.fn(),
    search: vi.fn(),
  };
  const storageOwner = {
    getConfirmed: (key: string) => fixture.read(key),
    watch: (key: string) =>
      new Observable<ContextDocumentsAttempt | undefined>((subscriber) => {
        subscriber.next(fixture.storage.get(key));
        return storageChanges.subscribe((changed) => {
          if (changed === key) subscriber.next(fixture.storage.get(key));
        });
      }),
    setConfirmed: async (
      key: string,
      value: ContextDocumentsAttempt | undefined,
    ) => {
      await fixture.persist(key, value);
      if (value) fixture.storage.set(key, value);
      else fixture.storage.delete(key);
      storageChanges.next(key);
    },
  };
  return {
    ...actual,
    useService: (service: { name?: string }) => {
      if (service === GlobalState) return storageOwner;
      if (service.name === "WorkbenchService")
        return { workbench: { openDoc: fixture.open } };
      if (service.name === "OrganizeService")
        return { folderTree: { rootFolder: root } };
      if (service.name === "MemberSearchService") return search;
      throw new Error(`Unexpected context assistance service ${service.name}`);
    },
  };
});
vi.mock("../tasks/use-workspace-tasks", async () => {
  const { LiveData, useLiveData } = await import("@myoxus/infra");
  const account$ = new LiveData<{ id: string } | null>({ id: "actor" });
  fixture.account = account$;
  const preferences = {
    assistanceRevision$: new LiveData(0),
    getAssistance: fixture.preferences,
  };
  const server = {
    id: "server",
    baseUrl: "http://myoxus.local",
    account$,
    gql: fixture.gql,
    scope: { get: () => preferences },
  };
  return {
    useTaskIdentity: () => {
      const account = useLiveData(account$);
      return {
        server,
        account,
        workspace: { id: "workspace" },
        availability: { status: "available" },
        identity: account ? `server/${account.id}/workspace` : null,
      };
    },
  };
});
const fonts = Object.getOwnPropertyDescriptor(document, "fonts");
beforeAll(() =>
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
  }),
);
afterAll(() => {
  if (fonts) Object.defineProperty(document, "fonts", fonts);
  else Reflect.deleteProperty(document, "fonts");
});
afterEach(cleanup);
const sources = assistantPackagesFixture(
  AssistantContext.TaskContainerAssistance,
);
let offeredSources = sources;
const source = sources[0];
const target = { databaseId: "database", taskId: "task" };
const assistance = {
  mode: AssistanceMode.Guided,
  interactiveMode: AssistanceMode.Guided,
  source: AssistanceSource.Workspace,
  userDefaultExplicit: true,
};
const key = contextDocumentsAttemptKey(
  "server",
  "actor",
  "workspace",
  target.databaseId,
  target.taskId,
);
function prepared(
  input: PrepareContextDocumentsInput,
): PreparedContextDocumentsFragmentFragment {
  // Only the native transport is simulated; controls and field bindings load
  // from the actual authored package rather than an invented UI descriptor.
  const folder = {
    kind: AssistantFolderDestinationKind.New,
    id: null,
    name: "Meeting records",
    parent: null,
  };
  return {
    target: {
      databaseId: input.target.databaseId,
      taskId: input.target.taskId ?? null,
    },
    package: input.identity,
    answers: [
      {
        input: "title",
        value: assistantValue(AssistantValueType.Text, {
          text: "Review API permissions",
        }),
      },
      {
        input: "folder",
        value: assistantValue(AssistantValueType.Folder, { folder }),
      },
      {
        input: "include-document",
        value: assistantValue(AssistantValueType.Boolean, { boolean: true }),
      },
    ],
    locale: input.locale,
    clientVersion: input.clientVersion,
    executionAvailable: true,
    planDigest: "a".repeat(64),
    folder,
    documents: [
      {
        source: {
          componentId: "document",
          templateId: "meeting-agenda",
          version: "1.1.0",
          digest: "b".repeat(64),
        },
        sourceRevisionId: "revision",
        sourceContentDigest: "c".repeat(64),
        locale: "en",
        title: "Review API permissions",
        folder,
      },
    ],
  };
}
function frozen(): ContextDocumentsAttempt {
  return {
    input: {
      workspaceId: "workspace",
      target,
      requestId: "request-original",
      identity: source.identity,
      answers: {
        title: { kind: "text", value: "Review API permissions" },
        folder: {
          kind: "folder",
          value: { kind: "new", name: "Meeting records" },
        },
        "include-document": { kind: "boolean", value: true },
      },
      locale: "en",
      clientVersion: 1,
      planDigest: "a".repeat(64),
    },
  };
}
function receipt(
  input = frozen().input,
  status = ProjectSetupStatus.Pending,
): ContextDocumentsFragmentFragment {
  return {
    run: null,
    canRetry: false,
    canStop: [
      ProjectSetupStatus.Pending,
      ProjectSetupStatus.Unavailable,
      ProjectSetupStatus.ReReviewRequired,
    ].includes(status),
    requestId: input.requestId,
    status,
    reasonCode: null,
    folderId: "folder",
    placementComplete: status === ProjectSetupStatus.Ready,
    acceptedPlan: prepared(input),
    acceptedDescriptor: source,
    currentReview: null,
    documents: [
      {
        componentId: "document",
        reservedDocumentId: "doc-id",
        externalId: status === ProjectSetupStatus.Ready ? "doc-external" : null,
        created: status === ProjectSetupStatus.Ready,
        placed: status === ProjectSetupStatus.Ready,
      },
    ],
    assistance,
  };
}
beforeEach(() => {
  offeredSources = sources;
  fixture.storage.clear();
  fixture.open.mockReset();
  fixture.persist.mockReset().mockResolvedValue(undefined);
  fixture.read
    .mockReset()
    .mockImplementation(async (key: string) => fixture.storage.get(key));
  fixture.preferences.mockReset().mockResolvedValue(assistance);
  fixture.account!.next({ id: "actor" });
  fixture.gql.mockReset().mockImplementation(async ({ query, variables }) => {
    if (query === assistantPackagesQuery)
      return {
        workspace: { id: "workspace", assistantPackages: offeredSources },
      };
    if (query === prepareContextDocumentsQuery)
      return {
        currentUser: { id: "actor" },
        workspace: {
          id: "workspace",
          prepareContextDocuments: {
            plan: prepared(variables.input),
            assistance,
            context: {
              containerTitle: "Engineering",
              taskTitle: "Review API permissions",
            },
          },
        },
      };
    if (query === contextDocumentsQuery)
      return {
        currentUser: { id: "actor" },
        workspace: {
          id: "workspace",
          contextDocuments: receipt(fixture.storage.get(key)?.input),
        },
      };
    if (query === applyContextDocumentsMutation)
      return {
        applyContextDocuments: receipt(
          variables.input,
          ProjectSetupStatus.Ready,
        ),
      };
    if (query === stopContextDocumentsMutation)
      return {
        stopContextDocuments: receipt(
          fixture.storage.get(key)?.input,
          ProjectSetupStatus.Stopped,
        ),
      };
    throw new Error(`Unexpected context operation ${query.id}`);
  });
});
function Harness() {
  const [shown, setShown] = useState(false);
  return (
    <ContextDocumentAssistance
      databaseId="database"
      title="Engineering"
      enabled
      onShow={() => setShown(true)}
      onClose={() => setShown(false)}
    >
      {({ content }) => (
        <>
          <ContextDocumentTaskMenu
            target={{
              ...target,
              title: "Review API permissions",
              projectId: "database",
            }}
            onOpenProject={fixture.open}
          />
          <Button onClick={() => setShown((value) => !value)}>
            Toggle surface
          </Button>
          {shown ? content : null}
        </>
      )}
    </ContextDocumentAssistance>
  );
}
function mount() {
  const element = () => (
    <MyoxusUIProvider env="test">
      <SWRConfig
        value={{
          provider: () => new Map(),
          dedupingInterval: 0,
          shouldRetryOnError: false,
        }}
      >
        <Harness />
      </SWRConfig>
    </MyoxusUIProvider>
  );
  const mounted = render(element());
  return { ...mounted, refresh: () => mounted.rerender(element()) };
}
async function choose(
  user: ReturnType<typeof userEvent.setup>,
  label = "Prepare meeting",
) {
  await user.click(screen.getByRole("button", { name: "Task actions" }));
  await user.click(await screen.findByRole("menuitem", { name: label }));
  await screen.findByTestId("context-document-assistance");
}
async function fillFolder(user: ReturnType<typeof userEvent.setup>) {
  await user.click(
    screen.getByRole("combobox", { name: "Folder destination type" }),
  );
  await user.click(await screen.findByRole("option", { name: "New folder" }));
  await user.type(
    await screen.findByRole("textbox", { name: "New folder name" }),
    "Meeting records",
  );
}
async function review(user: ReturnType<typeof userEvent.setup>) {
  await choose(user);
  const suggestion = await screen.findByTestId("context-assistance-use-title");
  await waitFor(() =>
    expect((suggestion as HTMLButtonElement).disabled).toBe(false),
  );
  await user.click(suggestion);
  await fillFolder(user);
  await user.click(screen.getByRole("button", { name: "Review preparation" }));
  return screen.findByRole("dialog", { name: "Review preparation" });
}
const calls = (query: { id: string }) =>
  fixture.gql.mock.calls.filter(([arg]) => arg.query.id === query.id);
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("native apply waits for durable ACK, single-flights double confirmation and opens only the acknowledged external ID", async () => {
  const user = userEvent.setup();
  offeredSources = [];
  const withdrawn = mount();
  await waitFor(() => expect(calls(assistantPackagesQuery)).toHaveLength(1));
  await user.click(screen.getByRole("button", { name: "Task actions" }));
  await waitFor(() =>
    expect(
      screen.queryByRole("menuitem", { name: "Prepare meeting" }),
    ).toBeNull(),
  );
  expect(screen.queryByText("Retry")).toBeNull();
  expect(calls(prepareContextDocumentsQuery)).toHaveLength(0);
  withdrawn.unmount();
  // The same consumer becomes available again from the server list alone.
  offeredSources = [...sources];
  const mounted = mount();
  const dialog = await review(user);
  const ack = deferred<void>();
  fixture.persist.mockReturnValueOnce(ack.promise);
  await user.dblClick(
    within(dialog).getByRole("button", { name: "Create editable copy" }),
  );
  expect(calls(applyContextDocumentsMutation)).toHaveLength(0);
  await act(async () => ack.resolve());
  await screen.findByRole("button", { name: "Review API permissions" });
  offeredSources.length = 0;
  mounted.refresh();
  expect(calls(applyContextDocumentsMutation)).toHaveLength(1);
  expect(fixture.storage.get(key)?.input).toEqual(
    calls(applyContextDocumentsMutation)[0][0].variables.input,
  );
  await user.click(
    screen.getByRole("button", { name: "Review API permissions" }),
  );
  expect(fixture.open).toHaveBeenCalledWith("doc-external", { at: "tail" });
});

test("rejected storage never starts apply and account ABA during ACK cannot submit with another actor", async () => {
  const user = userEvent.setup();
  const mounted = mount();
  const dialog = await review(user);
  fixture.persist.mockRejectedValueOnce(new Error("disk full"));
  await user.click(
    within(dialog).getByRole("button", { name: "Create editable copy" }),
  );
  await screen.findByText("Operation failed");
  expect(calls(applyContextDocumentsMutation)).toHaveLength(0);
  mounted.unmount();
  fixture.persist.mockReset().mockResolvedValue(undefined);
  mount();
  const retryDialog = await review(user);
  const ack = deferred<void>();
  fixture.persist.mockReturnValueOnce(ack.promise);
  await user.click(
    within(retryDialog).getByRole("button", { name: "Create editable copy" }),
  );
  act(() => {
    fixture.account!.next({ id: "other" });
    fixture.account!.next({ id: "actor" });
  });
  await act(async () => ack.resolve());
  expect(calls(applyContextDocumentsMutation)).toHaveLength(0);
});

test("late preparation for one source cannot replace another source's form or review", async () => {
  const user = userEvent.setup();
  const waiting = deferred<unknown>();
  const gql = fixture.gql.getMockImplementation()!;
  fixture.gql.mockImplementation(async (arg) =>
    arg.query === prepareContextDocumentsQuery ? waiting.promise : gql(arg),
  );
  mount();
  await choose(user);
  await user.click(await screen.findByTestId("context-assistance-use-title"));
  await fillFolder(user);
  await user.click(screen.getByRole("button", { name: "Review preparation" }));
  const input: PrepareContextDocumentsInput = calls(
    prepareContextDocumentsQuery,
  )[0][0].variables.input;
  await choose(user, "Record decisions");
  await act(async () =>
    waiting.resolve({
      currentUser: { id: "actor" },
      workspace: {
        id: "workspace",
        prepareContextDocuments: {
          plan: prepared(input),
          assistance,
          context: { containerTitle: "Engineering", taskTitle: "Old response" },
        },
      },
    }),
  );
  expect(screen.queryByRole("dialog")).toBeNull();
  expect({
    source: within(screen.getByTestId("context-document-assistance")).getByText(
      "Record decisions",
    ).textContent,
    title: (screen.getByRole("textbox", { name: "Title" }) as HTMLInputElement)
      .value,
  }).toEqual({ source: "Record decisions", title: "" });
  expect(calls(applyContextDocumentsMutation)).toHaveLength(0);
});

test.each(["actor"])(
  "foreign %s status readback cannot expose results or resume writes",
  async (foreign) => {
    const user = userEvent.setup();
    fixture.storage.set(key, frozen());
    const gql = fixture.gql.getMockImplementation()!;
    fixture.gql.mockImplementation(async (arg) =>
      arg.query === contextDocumentsQuery
        ? {
            currentUser: { id: foreign === "actor" ? "other" : "actor" },
            workspace: {
              id: foreign === "workspace" ? "other" : "workspace",
              contextDocuments: receipt(
                frozen().input,
                ProjectSetupStatus.Ready,
              ),
            },
          }
        : gql(arg),
    );
    mount();
    await choose(user);
    await waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: "Resume setup",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(true),
    );
    expect(
      screen.queryByRole("button", { name: "Review API permissions" }),
    ).toBeNull();
    expect(calls(applyContextDocumentsMutation)).toHaveLength(0);
    expect(fixture.storage.get(key)).toEqual(frozen());
  },
);

test("a lost apply response reloads the native receipt and opens the existing copy without another write", async () => {
  const user = userEvent.setup();
  const gql = fixture.gql.getMockImplementation()!;
  fixture.gql.mockImplementation(async (arg) => {
    if (arg.query === applyContextDocumentsMutation)
      throw new Error("response lost after acceptance");
    return gql(arg);
  });
  const mounted = mount();
  const dialog = await review(user);
  await user.click(
    within(dialog).getByRole("button", { name: "Create editable copy" }),
  );
  await screen.findByText(
    "The result is not confirmed. Check or resume this same request; do not start another copy.",
  );
  expect(
    screen.getAllByText(
      "The result is not confirmed. Check or resume this same request; do not start another copy.",
    ),
  ).toHaveLength(1);
  expect(
    ["Retry", "Check status", "Resume setup"].map(
      (name) =>
        (screen.getByRole("button", { name }) as HTMLButtonElement).disabled,
    ),
  ).toEqual([false, false, true]);
  const saved = fixture.storage.get(key)!;
  expect(saved.input).toEqual(
    calls(applyContextDocumentsMutation)[0][0].variables.input,
  );
  mounted.unmount();
  offeredSources = [];
  fixture.gql.mockClear();
  fixture.gql.mockImplementation(async (arg) =>
    arg.query === contextDocumentsQuery
      ? {
          currentUser: { id: "actor" },
          workspace: {
            id: "workspace",
            contextDocuments: receipt(saved.input, ProjectSetupStatus.Ready),
          },
        }
      : gql(arg),
  );
  mount();
  await user.click(await screen.findByRole("button", { name: "Task actions" }));
  await user.hover(
    await screen.findByRole("menuitem", { name: "Automation runs" }),
  );
  const retainedItem = await screen.findByRole("menuitem", {
    name: "Check status",
  });
  fireEvent.mouseDown(retainedItem);
  fireEvent.click(retainedItem);
  await user.click(
    await screen.findByRole("button", { name: "Review API permissions" }),
  );
  expect(fixture.open).toHaveBeenCalledWith("doc-external", { at: "tail" });
  expect(calls(contextDocumentsQuery)).toHaveLength(1);
  expect(calls(applyContextDocumentsMutation)).toHaveLength(0);
  expect(calls(prepareContextDocumentsQuery)).toHaveLength(0);
});

test("re-review renders the retained descriptor and sends only explicit admission confirmation on the original transport", async () => {
  const user = userEvent.setup();
  const saved = frozen();
  fixture.storage.set(key, saved);
  const gql = fixture.gql.getMockImplementation()!;
  const next = {
    ...prepared(saved.input),
    planDigest: "d".repeat(64),
    documents: prepared(saved.input).documents.map((doc) => ({
      ...doc,
      title: "Reviewed current source",
    })),
  };
  fixture.gql.mockImplementation(async (arg) =>
    arg.query === contextDocumentsQuery
      ? {
          currentUser: { id: "actor" },
          workspace: {
            id: "workspace",
            contextDocuments: {
              ...receipt(saved.input, ProjectSetupStatus.ReReviewRequired),
              currentReview: next,
            },
          },
        }
      : gql(arg),
  );
  mount();
  await choose(user);
  await screen.findByText("Reviewed current source");
  expect(calls(applyContextDocumentsMutation)).toHaveLength(0);
  await user.click(
    screen.getByRole("button", { name: "Create editable copy" }),
  );
  await waitFor(() =>
    expect(calls(applyContextDocumentsMutation)).toHaveLength(1),
  );
  expect(calls(applyContextDocumentsMutation)[0][0].variables.input).toEqual({
    ...saved.input,
    admissionConfirmation: next.planDigest,
  });
});

test("only the exact native Gone code permits deliberate local discard; rejected flag persistence stays conservative", async () => {
  const user = userEvent.setup();
  const saved = frozen();
  fixture.storage.set(key, saved);
  const gql = fixture.gql.getMockImplementation()!;
  fixture.gql.mockImplementation(async (arg) => {
    if (arg.query === contextDocumentsQuery)
      throw new GraphQLError("gone", {
        extensions: { code: "MIX_ASSISTANT_RESULT_GONE" },
      });
    return gql(arg);
  });
  fixture.persist.mockRejectedValueOnce(new Error("flush failed"));
  const mounted = mount();
  await choose(user);
  await screen.findByText(
    "The result is not confirmed. Check or resume this same request; do not start another copy.",
  );
  expect(
    screen.getAllByText(
      "The result is not confirmed. Check or resume this same request; do not start another copy.",
    ),
  ).toHaveLength(1);
  expect(
    ["Retry", "Check status", "Resume setup"].map(
      (name) =>
        (screen.getByRole("button", { name }) as HTMLButtonElement).disabled,
    ),
  ).toEqual([false, false, true]);
  expect(
    screen.queryByRole("button", { name: "Start a new setup" }),
  ).toBeNull();
  expect(fixture.storage.get(key)).toEqual(saved);
  mounted.unmount();
  mount();
  await choose(user);
  const fresh = await screen.findByRole("button", {
    name: "Start a new setup",
  });
  expect(fixture.storage.get(key)?.gone).toBe(true);
  await user.click(fresh);
  await waitFor(() => expect(fixture.storage.has(key)).toBe(false));
  expect(calls(applyContextDocumentsMutation)).toHaveLength(0);
  expect(calls(prepareContextDocumentsQuery)).toHaveLength(0);
});

test("corrupt or oversized native retained transport fails closed before any status or create RPC", async () => {
  fixture.storage.set(key, {
    ...frozen(),
    input: { ...frozen().input, answers: { notes: "😀".repeat(300_000) } },
  });
  const user = userEvent.setup();
  mount();
  await choose(user);
  await screen.findByText("Operation failed");
  expect(screen.queryByRole("button", { name: "Resume setup" })).toBeNull();
  expect(calls(contextDocumentsQuery)).toHaveLength(0);
  expect(calls(applyContextDocumentsMutation)).toHaveLength(0);
  expect(calls(prepareContextDocumentsQuery)).toHaveLength(0);
});
