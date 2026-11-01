// SPDX-License-Identifier: AGPL-3.0-or-later
/** @vitest-environment happy-dom */
import {
  AssistanceMode,
  AssistanceSource,
  AssistantContext,
  Permission,
  WorkspaceCreationStatus,
  WorkspaceInitialContent,
  WorkspaceInitialContentPolicy,
  workspaceAssistantPackagesQuery,
  prepareWorkspaceAssistantQuery,
  workspaceCreationQuery,
  type PrepareWorkspaceAssistantInput,
  type PreparedWorkspaceAssistantFragmentFragment,
  type WorkspaceCreationResultFragmentFragment,
  type CreateWorkspaceInput,
} from "@myoxus/graphql";
import { LiveData, MemoryMemento } from "@myoxus/infra";
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  type Document as HappyDocument,
  PropertySymbol,
  type Window as HappyWindow,
} from "happy-dom";
import { SWRConfig } from "swr";

import { afterEach, beforeEach, expect, test, vi } from "vitest";

import {
  AuthService,
  ServersService,
  UserPreferencesService,
  type Server,
} from "@myoxus/core/modules/server";
import { GlobalDialogService } from "@myoxus/core/modules/dialogs";
import { GlobalState } from "@myoxus/core/modules/storage";
import {
  WorkspacesService,
  type WorkspaceMetadata,
} from "@myoxus/core/modules/workspace";
import { assistantPackagesFixture } from "@myoxus/core/modules/database/presentation/test-fixtures";
import {
  workspaceInitialAnswers,
  workspaceCreationAttemptKey,
  readWorkspaceCreationAttempt,
  saveWorkspaceCreationAttempt,
} from "./model";

const owner = vi.hoisted(() => ({ services: new Map<unknown, unknown>() }));
vi.mock("@myoxus/infra", async (original) => ({
  ...(await original<typeof import("@myoxus/infra")>()),
  useService: (token: unknown) => {
    if (!owner.services.has(token)) throw new Error("Unexpected service");
    return owner.services.get(token);
  },
}));
vi.mock("@myoxus/i18n", async () =>
  (
    await import("@myoxus/core/modules/database/test-i18n-mock")
  ).createDatabaseTestI18nModule(),
);
vi.mock("@myoxus/core/modules/workspace/local-workspace-capability", () => ({
  canUseLocalWorkspaces: () => false,
}));
import { CreateWorkspaceDialog } from "./index";

const timerNames = [
  "setTimeout",
  "clearTimeout",
  "setInterval",
  "clearInterval",
] as const;
const originalTimers = Object.fromEntries(
  timerNames.map((name) => [name, globalThis[name]]),
);
const originalFonts = Object.getOwnPropertyDescriptor(document, "fonts");
const browserWindow = (document as unknown as HappyDocument)[
  PropertySymbol.defaultView
] as HappyWindow;
beforeEach(() => {
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
  });
  Object.assign(
    globalThis,
    Object.fromEntries(
      timerNames.map((name) => [name, browserWindow[name].bind(browserWindow)]),
    ),
  );
});
afterEach(async () => {
  cleanup();
  try {
    // Drain the native zero-delay batch before abort so RTL's next asyncWrapper
    // cannot append to a cleared Happy DOM batch on the reused Window.
    await new Promise<void>((resolve) => browserWindow.setTimeout(resolve, 0));
    await browserWindow.happyDOM.abort();
  } finally {
    vi.unstubAllGlobals();
    Object.assign(globalThis, originalTimers);
    if (originalFonts) Object.defineProperty(document, "fonts", originalFonts);
    else Reflect.deleteProperty(document, "fonts");
    owner.services.clear();
  }
});

function readyReceipt(
  requestId: string,
): WorkspaceCreationResultFragmentFragment {
  return {
    workspaceId: "workspace-created",
    requestId,
    acceptedPlan: null,
    projectSetup: null,
    setup: null,
    status: WorkspaceCreationStatus.Ready,
    rootReady: true,
    tasksReady: true,
    tasksDatabaseId: "tasks-native",
    assistanceSaved: true,
    retryRequired: false,
    reasonCode: null,
  };
}

function fixture() {
  const source = structuredClone(
    assistantPackagesFixture(AssistantContext.WorkspaceCreation)[0],
  );
  const state = new MemoryMemento();
  const account = new LiveData<{ id: string; label?: string } | null>({
    id: "actor-a",
    label: "Creator A",
  });
  let preparedName = "First workspace";
  const packages = [source];
  let receipt: WorkspaceCreationResultFragmentFragment | null = null;
  let receiptError: unknown;
  let prepared: PreparedWorkspaceAssistantFragmentFragment | null = null;
  const gql = vi.fn(
    async ({
      query,
    }: {
      query: unknown;
      variables?: {
        input?: PrepareWorkspaceAssistantInput;
        requestId?: string;
        workspaceId?: string;
      };
    }) => {
      if (query === workspaceAssistantPackagesQuery)
        return { currentUser: { id: "actor-a", assistantPackages: packages } };
      if (query === workspaceCreationQuery) {
        if (receiptError) throw receiptError;
        return { currentUser: { id: "actor-a", workspaceCreation: receipt } };
      }
      if (query === prepareWorkspaceAssistantQuery) {
        prepared = {
          setup: null,
          package: source.identity,
          planDigest: "canonical-plan",
          name: preparedName,
          initialContent: WorkspaceInitialContent.Empty,
          assistanceMode: AssistanceMode.Manual,
          answers: Object.entries(
            workspaceInitialAnswers(
              source,
              preparedName,
              AssistanceMode.Manual,
            ),
          ).map(([input, value]) => ({ input, value })),
          project: null,
        };
        return {
          currentUser: { id: "actor-a", prepareWorkspaceAssistant: prepared },
        };
      }
      throw new Error("Unexpected operation");
    },
  );
  const auth = { session: { account$: account } };
  const preferences = {
    userPreferences$: new LiveData({
      effectiveValues: {
        locale: "en",
        timezone: "UTC",
        dateFormat: "locale",
        timeFormat: "locale",
      },
    }),
    getAssistance: vi.fn(async () => ({
      mode: AssistanceMode.Manual,
      source: AssistanceSource.UserDefault,
      userDefaultExplicit: true,
      interactiveMode: AssistanceMode.Manual,
    })),
  };
  const server = {
    id: "server-a",
    baseUrl: "https://server.invalid",
    gql,
    scope: {
      get: (token: unknown) => {
        if (token === AuthService) return auth;
        if (token === UserPreferencesService) return preferences;
        throw new Error("Unexpected server service");
      },
    },
  } as unknown as Server;
  const server$ = new LiveData<Server | null>(server);
  const create = vi.fn(
    async (
      _flavour: string,
      _initial: unknown,
      options: { kind: "cloud-empty"; input: CreateWorkspaceInput },
    ): Promise<WorkspaceMetadata> => {
      receipt = readyReceipt(options.input.requestId);
      return {
        id: "workspace-created",
        flavour: "server-a",
        name: options.input.name,
        initialized: true,
        role: Permission.Owner,
        workspaceType: "UserOwned",
        initialContentPolicy: WorkspaceInitialContentPolicy.Empty,
        creation: receipt,
      };
    },
  );
  const signIn = vi.fn();
  owner.services.set(ServersService, {
    selectedServerId$: new LiveData("server-a"),
    servers$: new LiveData([server]),
    server$: () => server$,
  });
  owner.services.set(GlobalState, state);
  const listed = new LiveData<WorkspaceMetadata[]>([]);
  const refresh = vi.fn(async () => {
    listed.value = receipt
      ? [
          {
            id: receipt.workspaceId,
            flavour: "server-a",
            name: preparedName,
            role: Permission.Owner,
            initialized: true,
            workspaceType: "UserOwned",
            initialContentPolicy: WorkspaceInitialContentPolicy.Empty,
          },
        ]
      : [];
  });
  owner.services.set(WorkspacesService, {
    create,
    list: { workspaces$: listed, waitForRevalidation: refresh },
  });
  owner.services.set(GlobalDialogService, { open: signIn });
  const close = vi.fn();
  const cache = new Map();
  const mount = () =>
    render(
      <MyoxusUIProvider>
        <SWRConfig value={{ provider: () => cache, dedupingInterval: 0 }}>
          <CreateWorkspaceDialog serverId="server-a" close={close} />
        </SWRConfig>
      </MyoxusUIProvider>,
    );
  return {
    source,
    packages,
    preferences,
    setReceiptError: (error: unknown) => {
      receiptError = error;
    },
    setReceipt: (result: WorkspaceCreationResultFragmentFragment | null) => {
      receipt = result;
    },
    state,
    account,
    gql,
    create,
    refresh,
    close,
    signIn,
    mount,
    setPreparedName: (name: string) => {
      preparedName = name;
    },
  };
}

async function enterName(name: string) {
  const input = await screen.findByTestId("create-workspace-input");
  fireEvent.change(input, { target: { value: name } });
  await waitFor(() =>
    expect(
      screen
        .getByTestId("create-workspace-create-button")
        .hasAttribute("disabled"),
    ).toBe(false),
  );
  return input;
}

test("the name-only form binds confirmed mode and submits one native Empty request over LAN HTTP", async () => {
  vi.stubGlobal("crypto", {
    getRandomValues: crypto.getRandomValues.bind(crypto),
  });
  const f = fixture();
  f.mount();
  await enterName("First workspace");
  await waitFor(() =>
    expect(f.preferences.getAssistance).toHaveBeenCalledOnce(),
  );
  expect(screen.getAllByRole("textbox")).toHaveLength(1);
  expect(screen.queryByRole("radio")).toBeNull();
  expect(screen.queryByRole("combobox")).toBeNull();
  expect(screen.queryByTestId("database-assistant-next")).toBeNull();
  const create = screen.getByTestId("create-workspace-create-button");
  expect(create.getAttribute("type")).toBe("submit");
  expect(create.getAttribute("form")).toBe("create-workspace-form");
  fireEvent.submit(document.getElementById("create-workspace-form")!);
  await waitFor(() =>
    expect(f.close).toHaveBeenCalledWith({
      metadata: expect.objectContaining({
        id: "workspace-created",
        initialContentPolicy: WorkspaceInitialContentPolicy.Empty,
      }),
    }),
  );
  expect(f.create).toHaveBeenCalledTimes(1);
  expect(f.create.mock.calls[0][2].input.assistanceMode).toBe(
    AssistanceMode.Manual,
  );
  expect(
    f.state.get(workspaceCreationAttemptKey("server-a", "actor-a")),
  ).toBeUndefined();
});

test("lost response survives dialog remount and opens the confirmed native receipt without another creation", async () => {
  const f = fixture();
  f.create.mockRejectedValueOnce(new Error("connection lost after acceptance"));
  f.mount();
  await enterName("First workspace");
  fireEvent.click(await screen.findByTestId("create-workspace-create-button"));
  await screen.findByText("Please try again later.");
  await waitFor(() => expect(f.create).toHaveBeenCalledTimes(1));
  const original = f.create.mock.calls[0][2].input;
  expect(
    (
      await readWorkspaceCreationAttempt(
        f.state,
        workspaceCreationAttemptKey("server-a", "actor-a"),
      )
    )?.input,
  ).toEqual(original);
  cleanup();
  f.setReceipt(readyReceipt(original.requestId));
  f.mount();
  fireEvent.click(await screen.findByTestId("create-workspace-open-button"));
  await waitFor(() => expect(f.close).toHaveBeenCalledTimes(1));
  expect(f.create).toHaveBeenCalledTimes(1);
  expect(f.refresh).toHaveBeenCalledOnce();
  expect(
    f.gql.mock.calls.some(
      ([options]) =>
        options.query === workspaceCreationQuery &&
        options.variables?.requestId === original.requestId,
    ),
  ).toBe(true);
  expect(
    f.gql.mock.calls.filter(
      ([options]) => options.query === prepareWorkspaceAssistantQuery,
    ),
  ).toHaveLength(1);
});

test("a rejected pending-request durability ACK never starts workspace creation", async () => {
  const f = fixture();
  const ack = Promise.withResolvers<void>();
  const persist = vi.fn(async (key: string, value: unknown) => {
    await ack.promise;
    f.state.set(key, value);
  });
  Object.assign(f.state, { setConfirmed: persist });
  f.mount();
  await enterName("First workspace");
  fireEvent.click(await screen.findByTestId("create-workspace-create-button"));
  await waitFor(() => expect(persist).toHaveBeenCalledOnce());
  expect(f.create).not.toHaveBeenCalled();
  await act(async () => {
    ack.reject(new Error("flush failed"));
  });
  await screen.findByText("Please try again later.");
  expect(f.create).not.toHaveBeenCalled();
});

test("an account switch during the pending-request flush prevents the old owner's API write", async () => {
  const f = fixture();
  const ack = Promise.withResolvers<void>();
  const persist = vi.fn(async (key: string, value: unknown) => {
    await ack.promise;
    f.state.set(key, value);
  });
  Object.assign(f.state, { setConfirmed: persist });
  f.mount();
  await enterName("First workspace");
  fireEvent.click(await screen.findByTestId("create-workspace-create-button"));
  await waitFor(() => expect(persist).toHaveBeenCalledOnce());
  await act(async () => {
    f.account.value = null;
    f.account.value = { id: "actor-b" };
    ack.resolve();
  });
  expect(f.create).not.toHaveBeenCalled();
  expect(f.close).not.toHaveBeenCalled();
  expect(
    f.state.get(workspaceCreationAttemptKey("server-a", "actor-a")),
  ).toEqual(
    expect.objectContaining({
      input: expect.objectContaining({ name: "First workspace" }),
    }),
  );
});

test("recovery reads before resuming and keeps the exact request when receipt lookup is denied", async () => {
  const f = fixture();
  f.create.mockRejectedValueOnce(new Error("unknown write result"));
  f.mount();
  await enterName("First workspace");
  fireEvent.click(await screen.findByTestId("create-workspace-create-button"));
  await screen.findByText("Please try again later.");
  await waitFor(() => expect(f.create).toHaveBeenCalledOnce());
  const original = f.create.mock.calls[0][2].input;
  cleanup();
  const normal = f.gql.getMockImplementation()!;
  f.gql.mockImplementation(async (options) => {
    if (options.query === workspaceCreationQuery)
      throw new Error("permission denied");
    return normal(options);
  });
  f.mount();
  await screen.findByText("Please try again later.");
  fireEvent.click(screen.getByTestId("create-workspace-create-button"));
  await waitFor(() =>
    expect(
      f.gql.mock.calls.filter(
        ([options]) => options.query === workspaceCreationQuery,
      ),
    ).toHaveLength(2),
  );
  expect(f.create).toHaveBeenCalledOnce();
  expect(
    (
      await readWorkspaceCreationAttempt(
        f.state,
        workspaceCreationAttemptKey("server-a", "actor-a"),
      )
    )?.input,
  ).toEqual(original);
});

async function retainedEmptyFixture() {
  const f = fixture();
  const input: CreateWorkspaceInput = {
    name: "Accepted Workspace",
    initialContent: WorkspaceInitialContent.Empty,
    assistanceMode: AssistanceMode.Manual,
    requestId: "11111111-1111-4111-8111-111111111111",
    assistantConfirmation: {
      identity: f.source.identity,
      answers: {},
      planDigest: "outer-plan",
    },
  };
  const result = readyReceipt(input.requestId);
  await saveWorkspaceCreationAttempt(
    f.state,
    workspaceCreationAttemptKey("server-a", "actor-a"),
    { input },
  );
  f.setReceipt(result);
  return { ...f, input, result };
}

test("a foreign currentUser receipt cannot expose results or resume the opening actor's request", async () => {
  const f = await retainedEmptyFixture();
  const normal = f.gql.getMockImplementation()!;
  f.gql.mockImplementation(async (options) =>
    options.query === workspaceCreationQuery
      ? { currentUser: { id: "actor-b", workspaceCreation: f.result } }
      : normal(options),
  );
  f.mount();
  await screen.findByText("Please try again later.");
  expect(screen.queryByTestId("create-workspace-open-button")).toBeNull();
  fireEvent.click(screen.getByTestId("create-workspace-create-button"));
  await waitFor(() =>
    expect(
      f.gql.mock.calls.filter(
        ([options]) => options.query === workspaceCreationQuery,
      ),
    ).toHaveLength(2),
  );
  expect(f.create).not.toHaveBeenCalled();
  expect(f.close).not.toHaveBeenCalled();
});
