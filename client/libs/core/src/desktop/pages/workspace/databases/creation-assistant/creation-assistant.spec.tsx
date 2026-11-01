// SPDX-License-Identifier: AGPL-3.0-or-later
/** @vitest-environment happy-dom */

import {
  AssistantContext,
  AssistantActionKind,
  AssistantControlKind,
  type AssistantPackageFragmentFragment,
  assistantPackagesQuery,
  prepareProjectAssistantQuery,
  projectSetupQuery,
  stopProjectSetupMutation,
  ProjectSetupStatus,
  DatabaseProfileKind,
  DatabaseStarterTemplateCategory,
  type DatabaseStarterTemplateFragment,
  DatabaseViewKind,
  ProjectOptionPreset,
  ProjectStructurePreset,
} from "@myoxus/graphql";
import { UserPreferencesService } from "@myoxus/core/modules/server";
import { GlobalState } from "@myoxus/core/modules/storage";
import { GraphQLError } from "@myoxus/error";
import { record } from "../../../../../modules/database/test-fixtures";

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
import { SWRConfig } from "swr";
import {
  type Document as HappyDocument,
  PropertySymbol,
  type Window as HappyWindow,
} from "happy-dom";
import { type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  assistantPackagesFixture,
  preparedProjectFixture,
} from "../../../../../modules/database/presentation/test-fixtures";
const assistantServer = vi.hoisted(() => ({
  gql: vi.fn(),
  modals: vi.fn(),
  openLibrary: vi.fn(),
  defaultCurrency: "EUR",
  storage: new Map<string, unknown>(),
  persist: vi.fn(),
  read: vi.fn(),
  status: "Ready",
  plan: null as ReturnType<typeof preparedProjectFixture> | null,
  currentReview: null as ReturnType<typeof preparedProjectFixture> | null,
  acceptedDescriptor: null as AssistantPackageFragmentFragment | null,
  partialDatabase: false,
  account: null as import("@myoxus/infra").LiveData<{ id: string }> | null,

  packages: null as AssistantPackageFragmentFragment[] | null,
}));
vi.mock("@myoxus/infra", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@myoxus/infra")>();
  const member = {
    id: "accepted-member",
    name: "Ada",
    email: "ada@myoxus.local",
    avatarUrl: "",
  };
  const memberResult = new actual.LiveData([member]);
  const publicMember = new actual.LiveData(member);
  const memberLoading = new actual.LiveData(false);
  const search = {
    result$: memberResult,
    reset: vi.fn(),
    loadMore: vi.fn(),
    search: vi.fn(),
  };
  const users = {
    publicUser$: () => publicMember,
    isLoading$: () => memberLoading,
    revalidate: vi.fn(),
  };
  const storageOwner = {
    getConfirmed: (key: string) => assistantServer.read(key),
    setConfirmed: async (key: string, value: unknown) => {
      await assistantServer.persist(key, value);
      if (value === undefined) assistantServer.storage.delete(key);
      else assistantServer.storage.set(key, value);
    },
  };
  return {
    ...actual,
    useService: (service: { name: string }) => {
      if (service === GlobalState) return storageOwner;
      if (service.name === "MemberSearchService") return search;
      if (service.name === "PublicUserService") return users;
      if (service.name !== "WorkbenchService")
        throw new Error(`Unexpected assistant service ${service.name}`);
      return {
        workbench: {
          open: assistantServer.openLibrary,
          openDoc: assistantServer.openLibrary,
        },
      };
    },
  };
});
vi.mock(
  "@myoxus/core/components/hooks/myoxus/use-user-preferences",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@myoxus/core/components/hooks/myoxus/use-user-preferences")
    >()),
    useRegionalPreferences: () => ({
      locale: "en",
      timezone: "Pacific/Honolulu",
      dateFormat: "year-month-day",
      timeFormat: "24-hour",
    }),
  }),
);

vi.mock("@myoxus/core/modules/database/tasks/use-workspace-tasks", async () => {
  const { LiveData } = await import("@myoxus/infra");
  const account$ = new LiveData({ id: "actor" });
  assistantServer.account = account$;
  const preferences = { getSavedSetups: vi.fn(async () => []) };
  const owner = {
    identity: "server/actor/workspace",
    server: {
      id: "server",
      baseUrl: "http://myoxus.local",
      gql: assistantServer.gql,
      account$,
      scope: {
        get: (service: unknown) => {
          if (service === UserPreferencesService) return preferences;
          throw new Error("Unexpected assistant server service");
        },
      },
    },
    account: { id: "actor" },
    workspace: { id: "workspace" },
    availability: { status: "available" },
  };
  return { useTaskIdentity: () => owner };
});
beforeEach(() => {
  assistantServer.modals.mockReset();
  assistantServer.openLibrary.mockReset();
  assistantServer.defaultCurrency = "EUR";
  assistantServer.packages = null;
  assistantServer.storage.clear();
  assistantServer.persist.mockReset().mockResolvedValue(undefined);
  assistantServer.read
    .mockReset()
    .mockImplementation(async (key: string) =>
      assistantServer.storage.get(key),
    );
  assistantServer.status = ProjectSetupStatus.Ready;
  assistantServer.plan = null;
  assistantServer.currentReview = null;
  assistantServer.acceptedDescriptor = null;
  assistantServer.partialDatabase = false;
  assistantServer.account?.next({ id: "actor" });
  assistantServer.gql
    .mockReset()
    .mockImplementation(async ({ query, variables }) => {
      if (query === assistantPackagesQuery)
        return {
          workspace: {
            id: "workspace",
            assistantPackages:
              assistantServer.packages ??
              assistantPackagesFixture(AssistantContext.ProjectCreation, {
                "myoxus.assistant.project.simple_project": "1.0.0",
                "myoxus.assistant.project.product_roadmap": "1.0.0",
                "myoxus.assistant.project.bug_tracker": "1.0.0",
              }),
          },
        };
      if (query === prepareProjectAssistantQuery) {
        const packages =
          assistantServer.packages ??
          assistantPackagesFixture(AssistantContext.ProjectCreation, {
            "myoxus.assistant.project.simple_project": "1.0.0",
            "myoxus.assistant.project.product_roadmap": "1.0.0",
            "myoxus.assistant.project.bug_tracker": "1.0.0",
          });
        assistantServer.acceptedDescriptor =
          packages.find(
            (item) => item.identity.id === variables.input.identity.id,
          ) ?? null;
        assistantServer.plan = preparedProjectFixture(
          variables.input,
          assistantServer.defaultCurrency,
          packages,
        );
        return {
          currentUser: { id: "actor" },
          workspace: {
            id: "workspace",
            prepareProjectAssistant: assistantServer.plan,
          },
        };
      }
      if (query === projectSetupQuery || query === stopProjectSetupMutation) {
        if (!assistantServer.plan)
          throw new Error("Expected an actual reviewed plan");
        if (query === stopProjectSetupMutation)
          assistantServer.status = ProjectSetupStatus.Stopped;
        const setup = {
          requestId: variables.requestId ?? variables.input.requestId,
          status: assistantServer.status,
          reservedDatabaseId: "database-created",
          acceptedPlan: assistantServer.plan,
          acceptedDescriptor: assistantServer.acceptedDescriptor,
          currentReview: assistantServer.currentReview,
          reasonCode: null,
          folderId: null,
          placementComplete:
            assistantServer.status === ProjectSetupStatus.Ready,
          documents: [],
          database:
            assistantServer.status === ProjectSetupStatus.Ready ||
            assistantServer.partialDatabase
              ? {
                  ...record,
                  database: { ...record.database, id: "database-created" },
                  initialViewId: undefined,
                }
              : null,
        };
        return query === projectSetupQuery
          ? {
              currentUser: { id: "actor" },
              workspace: { id: "workspace", projectSetup: setup },
            }
          : { stopProjectSetup: setup };
      }
      throw new Error("Unexpected Project assistant query");
    });
});

vi.mock("@myoxus/i18n", async () => {
  const { createDatabaseTestI18nModule } =
    await import("../../../../../modules/database/test-i18n-mock");
  return createDatabaseTestI18nModule();
});

vi.mock("@myoxus/ui-facade", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@myoxus/ui-facade")>();
  return {
    ...actual,
    // Modal behavior belongs to the Facade. Keeping its content mounted here
    // makes state-machine and keyboard failures deterministic.
    Modal: ({
      children,
      contentOptions,
      open,
      title,
      returnFocusRef,
    }: {
      children: ReactNode;
      contentOptions?: Record<string, string>;
      open?: boolean;
      title?: ReactNode;
      returnFocusRef?: { current: HTMLElement | null };
    }) => {
      assistantServer.modals({ title, returnFocusRef, open });
      return open ? (
        <section {...contentOptions} aria-label={String(title)} role="dialog">
          {children}
        </section>
      ) : null;
    },
  };
});

import {
  DatabaseCreationAssistant,
  type DatabaseCreationAssistantProps,
} from "./creation-assistant";

const originalMatchMedia = window.matchMedia;
const originalDocumentFonts = Object.getOwnPropertyDescriptor(
  document,
  "fonts",
);
const timerNames = [
  "setTimeout",
  "clearTimeout",
  "setInterval",
  "clearInterval",
] as const;
const originalTimers = Object.fromEntries(
  timerNames.map((name) => [name, globalThis[name]]),
);
const browserWindow = (document as unknown as HappyDocument)[
  PropertySymbol.defaultView
] as HappyWindow;

// Bind only the component test's timers to Happy DOM. Restore after abort so
// RTL's async wrapper and the runner never schedule onto a torn-down owner.
// https://github.com/capricorn86/happy-dom/wiki/Setup-as-Test-Environment
beforeEach(() => {
  Object.assign(
    globalThis,
    Object.fromEntries(
      timerNames.map((name) => [name, browserWindow[name].bind(browserWindow)]),
    ),
  );
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      addEventListener: vi.fn(),
      addListener: vi.fn(),
      dispatchEvent: vi.fn(),
      matches: false,
      media: query,
      onchange: null,
      removeEventListener: vi.fn(),
      removeListener: vi.fn(),
    })),
    writable: true,
  });
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
  });
});

afterEach(async () => {
  cleanup();
  try {
    // Drain the native zero-delay batch before abort; clearing its backing timer
    // otherwise strands later setTimeout(0) callbacks on this reused Window.
    await new Promise<void>((resolve) => browserWindow.setTimeout(resolve, 0));
    await browserWindow.happyDOM.abort();
  } finally {
    Object.assign(globalThis, originalTimers);
  }
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: originalMatchMedia,
    writable: true,
  });
  if (originalDocumentFonts) {
    Object.defineProperty(document, "fonts", originalDocumentFonts);
  } else {
    Reflect.deleteProperty(document, "fonts");
  }
});

const DATABASE_TEMPLATE: DatabaseStarterTemplateFragment = {
  id: "myoxus.database.blank",
  version: "1.0.0",
  digest: "fixture-database",
  defaultVariant: {
    priority: ProjectOptionPreset.ThreeStep,
    complexity: ProjectOptionPreset.ThreeStep,
    structure: ProjectStructurePreset.TasksOnly,
  },
  selections: [],
  name: "Blank database",
  nameKey: "com.myoxus.database.starter-template.database-blank.name",
  description: "Start without fields",
  descriptionKey:
    "com.myoxus.database.starter-template.database-blank.description",
  category: DatabaseStarterTemplateCategory.Database,
  profileKind: DatabaseProfileKind.Generic,
  defaultViewKinds: [DatabaseViewKind.Table],
  sampleRowCount: 0,
  importMappings: [],
};

const PROJECT_TEMPLATE: DatabaseStarterTemplateFragment = {
  id: "myoxus.project.simple_project",
  version: "1.0.0",
  digest: "fixture-project",
  defaultVariant: {
    priority: ProjectOptionPreset.ThreeStep,
    complexity: ProjectOptionPreset.ThreeStep,
    structure: ProjectStructurePreset.Phases,
  },
  selections: [],
  name: "Simple project",
  nameKey: "com.myoxus.database.starter-template.project-simple-project.name",
  description: "Plan a project",
  descriptionKey:
    "com.myoxus.database.starter-template.project-simple-project.description",
  category: DatabaseStarterTemplateCategory.Project,
  profileKind: DatabaseProfileKind.Project,
  defaultViewKinds: [DatabaseViewKind.Kanban, DatabaseViewKind.Table],
  sampleRowCount: 4,
  importMappings: [],
};

function createCallbacks() {
  return {
    onCreate: vi.fn().mockResolvedValue({ databaseId: "database-created" }),
    onLinkFolder: vi.fn().mockResolvedValue(undefined),
    onComplete: vi.fn(),
    onOpenChange: vi.fn(),
    onRetryTemplates: vi.fn(),
  };
}

function assistantProps(
  intent: DatabaseCreationAssistantProps["intent"] = "database",
): DatabaseCreationAssistantProps {
  return {
    open: true,
    intent,
    templates: [DATABASE_TEMPLATE, PROJECT_TEMPLATE],
    templatesLoading: false,
    templatesError: false,
    folders: [{ value: "folder-1", label: "Planning" }],
    creating: false,
    ...createCallbacks(),
  };
}

function renderAssistant(
  overrides: Partial<DatabaseCreationAssistantProps> = {},
) {
  const props = { ...assistantProps(), ...overrides };
  // Keep real controls in Mantine's deterministic test rendering environment.
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <MyoxusUIProvider env="test">
        <DatabaseCreationAssistant {...props} />
      </MyoxusUIProvider>
    </SWRConfig>,
  );
  return props;
}

async function advanceToProjectSetup() {
  const next = await screen.findByTestId("database-assistant-next");
  fireEvent.click(next);
  fireEvent.change(screen.getByRole("textbox", { name: /^Project name/ }), {
    target: { value: "Release project" },
  });
  fireEvent.change(screen.getByRole("textbox", { name: /^Description/ }), {
    target: { value: "Coordinate the release" },
  });
  fireEvent.click(screen.getByRole("combobox", { name: "Folder" }));
  const planning = await screen.findByRole("option", { name: "Planning" });
  fireEvent.click(planning);
  fireEvent.click(screen.getByTestId("database-assistant-next"));
}

async function advanceToProjectReview() {
  await advanceToProjectSetup();
  fireEvent.click(screen.getByTestId("database-assistant-next"));
  return screen.findByTestId("database-assistant-create");
}

describe("Database creation assistant", () => {
  test("keeps entry intents separate and removes the old select workflow", async () => {
    const first = renderAssistant();

    expect(
      (
        await screen.findByRole("radio", { name: /Blank database/i })
      ).getAttribute("aria-checked"),
    ).toBe("true");
    expect(screen.queryByRole("radio", { name: /Simple project/i })).toBeNull();
    expect(
      screen.queryByTestId("database-template-category-filter"),
    ).toBeNull();
    expect(screen.queryByTestId("database-template-select")).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();

    cleanup();
    renderAssistant({ ...first, intent: "project" });
    expect(
      (
        await screen.findByRole("radio", { name: /Simple project/i })
      ).getAttribute("aria-checked"),
    ).toBe("true");
    expect(screen.queryByRole("radio", { name: /Blank database/i })).toBeNull();
  });

  test("uses only the injected server catalog and clears a hidden search selection", async () => {
    const templates = Array.from({ length: 8 }, (_, index) => ({
      ...DATABASE_TEMPLATE,
      id: index === 0 ? DATABASE_TEMPLATE.id : `server-template-${index}`,
      name: `Server template ${index}`,
      nameKey: `server.template.${index}.name`,
      descriptionKey: `server.template.${index}.description`,
    }));
    renderAssistant({ templates });

    const search = await screen.findByLabelText("Search templates");
    fireEvent.change(search, { target: { value: "not-in-the-catalog" } });
    expect(
      screen.getByTestId("database-assistant-template-empty").dataset
        .myoxusUiRole,
    ).toBe("empty-state");
    expect(
      (screen.getByTestId("database-assistant-next") as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    fireEvent.change(search, { target: { value: "Server template 2" } });
    const serverChoice = screen.getByRole("radio", {
      name: /Server template 2/i,
    });
    expect(
      (screen.getByTestId("database-assistant-next") as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.click(serverChoice);
    expect(
      (screen.getByTestId("database-assistant-next") as HTMLButtonElement)
        .disabled,
    ).toBe(false);

    cleanup();
    renderAssistant({ templates: [PROJECT_TEMPLATE] });
    expect(
      screen.getByTestId("database-assistant-template-empty").dataset
        .myoxusUiRole,
    ).toBe("empty-state");
    expect(screen.queryByText("Blank database")).toBeNull();
  });

  test("keeps loading and query failure inside the open assistant", async () => {
    const retry = vi.fn();
    const { rerender } = render(
      <MyoxusUIProvider env="test">
        <DatabaseCreationAssistant
          {...assistantProps()}
          templatesLoading
          onRetryTemplates={retry}
        />
      </MyoxusUIProvider>,
    );
    await waitFor(() =>
      expect(
        document.querySelectorAll(
          '[data-myoxus-ui-role="radio-selection-card-skeleton"]',
        ),
      ).toHaveLength(4),
    );

    rerender(
      <MyoxusUIProvider env="test">
        <DatabaseCreationAssistant
          {...assistantProps()}
          templatesError
          onRetryTemplates={retry}
        />
      </MyoxusUIProvider>,
    );
    expect(
      (await screen.findByText("Templates could not be loaded")).textContent,
    ).toBe("Templates could not be loaded");
    expect(screen.queryByText("Databases unavailable")).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledOnce();
    expect(
      screen.getByTestId("database-creation-assistant").getAttribute("role"),
    ).toBe("dialog");
  });

  test("a new package with one native form prepares a readonly confirmation and Cancel preserves its draft", async () => {
    const descriptor = structuredClone(
      assistantPackagesFixture(AssistantContext.ProjectCreation)[0],
    );
    descriptor.identity = {
      ...descriptor.identity,
      id: "fixture.configured.new-project",
    };
    const source = descriptor.presentation.steps;
    const create = source
      .flatMap((step) => step.actions)
      .find((action) => action.action === AssistantActionKind.CreateProject)!;
    const cancel = source
      .flatMap((step) => step.actions)
      .find((action) => action.action === AssistantActionKind.Cancel)!;
    const review = source
      .flatMap((step) => step.groups)
      .find((group) =>
        group.controls.some(
          (control) => control.kind === AssistantControlKind.ProjectReview,
        ),
      )!;
    const inputs = source
      .flatMap((step) => step.groups)
      .map((group) => ({
        ...group,
        controls: group.controls.filter(
          (control) => control.kind === AssistantControlKind.Input,
        ),
      }))
      .filter((group) => group.controls.length);
    descriptor.presentation = {
      guidedHelp: null,
      steps: [
        {
          id: "configured-form",
          title: descriptor.name,
          groups: inputs,
          actions: [cancel, { ...create, dialog: "review-confirm" }],
        },
      ],
      dialogs: [
        {
          id: "review-confirm",
          title: {
            en: "Confirm configured project",
            de: "Projekt bestätigen",
            fr: "Confirmer le projet",
            es: "Confirmar proyecto",
          },
          groups: [review],
          actions: [cancel, create],
        },
      ],
    };
    assistantServer.packages = [descriptor];
    const props = renderAssistant({ intent: "project" });
    const user = userEvent.setup();
    const title = await screen.findByRole("textbox", { name: /^Project name/ });
    fireEvent.change(title, { target: { value: "Configured native project" } });
    const description = screen.getByRole("textbox", { name: /^Description/ });
    fireEvent.change(description, { target: { value: "Source-owned form" } });
    await user.type(description, "{Enter}");
    // Multiline input keeps Enter as content, not an implicit apply.
    expect(props.onCreate).not.toHaveBeenCalled();
    const confirmationTrigger = screen.getByTestId("database-assistant-create");
    await user.click(confirmationTrigger);
    const dialog = await screen.findByRole("dialog", {
      name: "Confirm configured project",
    });
    expect(
      assistantServer.modals.mock.calls.findLast(
        ([props]) => props.title === "Confirm configured project" && props.open,
      )?.[0].returnFocusRef.current,
    ).toBe(confirmationTrigger);
    expect(
      within(dialog)
        .getByText("Configured native project")
        .checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }),
    ).toBe(true);
    expect(props.onCreate).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(
      screen.queryByRole("dialog", { name: "Confirm configured project" }),
    ).toBeNull();
    expect(
      (
        screen.getByRole("textbox", {
          name: /^Project name/,
        }) as HTMLInputElement
      ).value,
    ).toBe("Configured native project");
    await user.click(screen.getByTestId("database-assistant-create"));
    const confirmation = await screen.findByRole("dialog", {
      name: "Confirm configured project",
    });
    await user.click(
      within(confirmation).getByRole("button", { name: "Create project" }),
    );
    await waitFor(() => expect(props.onCreate).toHaveBeenCalledOnce());
    expect(props.onCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        assistantConfirmation: expect.objectContaining({
          identity: descriptor.identity,
          planDigest: "fixture-canonical-plan",
        }),
      }),
    );
  });

  test("switching packages uses their defaults while retaining explicit draft edits and entry context", async () => {
    const packages = assistantPackagesFixture(AssistantContext.ProjectCreation);
    const configured = structuredClone(packages[0]);
    configured.identity = {
      ...configured.identity,
      id: "qa.workspace.project.file_form",
    };
    configured.defaultFor = [];
    configured.name = {
      en: "File defaults offering",
      de: "Dateivorgaben",
      fr: "Valeurs du fichier",
      es: "Valores del archivo",
    };
    const view = configured.inputs.find(
      (input) => input.target === "InitialView",
    )!;
    view.defaultValue = { ...view.defaultValue!, choice: "kanban" };
    const priority = configured.inputs.find(
      (input) => input.target === "PriorityPreset",
    )!;
    const five = priority.choices.find(
      (choice) =>
        choice.value.choice?.replaceAll("_", "").toLowerCase() ===
        ProjectOptionPreset.FiveStep.toLowerCase(),
    )!;
    priority.defaultValue = { ...priority.defaultValue!, choice: five.id };
    const samples = configured.inputs.find(
      (input) => input.target === "IncludeSamples",
    )!;
    samples.defaultValue = { ...samples.defaultValue!, boolean: true };
    assistantServer.packages = [...packages, configured];
    renderAssistant({
      intent: "project",
      initialStructurePreset: ProjectStructurePreset.TasksOnly,
    });
    await advanceToProjectSetup();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.click(
      screen.getByRole("radio", { name: /File defaults offering/ }),
    );
    fireEvent.click(screen.getByTestId("database-assistant-next"));
    expect(
      (
        screen.getByRole("textbox", {
          name: /^Project name/,
        }) as HTMLInputElement
      ).value,
    ).toBe("Release project");
    expect(
      (
        screen.getByRole("textbox", {
          name: /^Description/,
        }) as HTMLInputElement
      ).value,
    ).toBe("Coordinate the release");
    fireEvent.click(screen.getByTestId("database-assistant-next"));
    expect(
      (screen.getByTestId("database-assistant-priority") as HTMLInputElement)
        .value,
    ).toBe("5-step");
    expect(
      (screen.getByRole("combobox", { name: "View type" }) as HTMLInputElement)
        .value,
    ).toBe("Kanban");
    expect(
      (screen.getByTestId("database-assistant-samples") as HTMLInputElement)
        .checked,
    ).toBe(true);
    const structure = configured.inputs.find(
      (input) => input.target === "StructurePreset",
    )!;
    const tasks = structure.choices.find(
      (choice) => choice.value.choice === "tasks_only",
    )!;
    expect(
      screen
        .getByTestId(`database-assistant-structure-${tasks.id}`)
        .hasAttribute("data-checked"),
    ).toBe(true);
    // An explicit choice survives a later switch; an untouched default does not.
    fireEvent.click(screen.getByRole("combobox", { name: "View type" }));
    fireEvent.click(await screen.findByRole("option", { name: "Table" }));
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.click(screen.getByRole("radio", { name: /Simple project/i }));
    fireEvent.click(
      screen.getByRole("radio", { name: /File defaults offering/ }),
    );
    fireEvent.click(screen.getByTestId("database-assistant-next"));
    fireEvent.click(screen.getByTestId("database-assistant-next"));
    expect(
      (screen.getByRole("combobox", { name: "View type" }) as HTMLInputElement)
        .value,
    ).toBe("Table");
  });

  test("validates details, retains state and submits every Project option", async () => {
    const props = renderAssistant({ intent: "project" });
    fireEvent.click(await screen.findByTestId("database-assistant-next"));

    expect(screen.queryByText("Description is required.")).toBeNull();
    expect(screen.queryByText("Project name is required.")).toBeNull();
    const title = screen.getByRole("textbox", { name: /^Project name/ });
    const titleInvalid = vi.fn();
    title.addEventListener("invalid", titleInvalid);
    fireEvent.change(title, { target: { value: "" } });
    fireEvent.click(screen.getByTestId("database-assistant-next"));
    expect(titleInvalid).toHaveBeenCalled();
    expect((title as HTMLInputElement).required).toBe(true);
    expect((title as HTMLInputElement).validity.valueMissing).toBe(true);
    expect((title as HTMLInputElement).labels?.[0]?.textContent).toContain(
      "Project name",
    );
    expect(
      (screen.getByTestId("database-assistant-next") as HTMLButtonElement).form,
    ).toBe((title as HTMLInputElement).form);
    expect(props.onCreate).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: /^Project name/ })).toBe(title);
    expect((title as HTMLInputElement).checkValidity()).toBe(false);

    fireEvent.change(title, { target: { value: "Release project" } });
    const description = screen.getByRole("textbox", { name: /^Description/ });
    const descriptionInvalid = vi.fn();
    description.addEventListener("invalid", descriptionInvalid);
    fireEvent.click(screen.getByTestId("database-assistant-next"));
    expect(screen.getByRole("textbox", { name: /^Description/ })).toBe(
      description,
    );
    // Native constraint validation runs before onSubmit and owns its field feedback.
    expect(descriptionInvalid).toHaveBeenCalled();
    expect((description as HTMLTextAreaElement).checkValidity()).toBe(false);
    expect((description as HTMLTextAreaElement).required).toBe(true);
    expect((description as HTMLTextAreaElement).validity.valueMissing).toBe(
      true,
    );
    expect(
      (description as HTMLTextAreaElement).labels?.[0]?.textContent,
    ).toContain("Description");
    expect((description as HTMLTextAreaElement).form).toBe(
      (title as HTMLInputElement).form,
    );
    expect(props.onCreate).not.toHaveBeenCalled();
    expect(
      assistantServer.gql.mock.calls.some(
        ([request]) => request.query === prepareProjectAssistantQuery,
      ),
    ).toBe(false);

    fireEvent.change(description, {
      target: { value: "Coordinate the release" },
    });
    fireEvent.click(screen.getByRole("combobox", { name: "Folder" }));
    fireEvent.click(await screen.findByRole("option", { name: "Planning" }));
    fireEvent.click(screen.getByTestId("database-assistant-next"));

    const priority = screen.getByTestId("database-assistant-priority");
    const complexity = screen.getByTestId("database-assistant-complexity");
    expect((priority as HTMLInputElement).value).toBe("3-step");
    expect((complexity as HTMLInputElement).value).toBe("3-step");
    expect(
      screen
        .getByText("Priority preset: Choose three or five levels.")
        .checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }),
    ).toBe(true);
    expect(
      screen
        .getByText("Complexity preset: Choose three or five levels.")
        .checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }),
    ).toBe(true);
    fireEvent.click(priority);
    fireEvent.click(await screen.findByRole("option", { name: "5-step" }));
    fireEvent.click(complexity);
    fireEvent.click(await screen.findByRole("option", { name: "5-step" }));

    for (const preset of [
      ProjectStructurePreset.TasksOnly,
      ProjectStructurePreset.Phases,
      ProjectStructurePreset.Milestones,
      ProjectStructurePreset.PhasesAndMilestones,
    ]) {
      const input = assistantPackagesFixture(
        AssistantContext.ProjectCreation,
      )[0].inputs.find((input) => input.target === "StructurePreset")!;
      const authored = input.choices.find(
        (choice) =>
          choice.value.choice?.replaceAll("_", "").toLowerCase() ===
          preset.toLowerCase(),
      )!;
      const choice = screen.getByTestId(
        `database-assistant-structure-${authored.id}`,
      );
      fireEvent.click(choice);
      expect(choice.hasAttribute("data-checked")).toBe(true);
    }
    const samples = screen.getByTestId(
      "database-assistant-samples",
    ) as HTMLInputElement;
    expect(samples.checked).toBe(false);
    fireEvent.click(samples);
    expect(samples.checked).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(
      (screen.getByDisplayValue("Release project") as HTMLInputElement).value,
    ).toBe("Release project");
    expect(
      (screen.getByDisplayValue("Coordinate the release") as HTMLInputElement)
        .value,
    ).toBe("Coordinate the release");
    expect(
      (screen.getByDisplayValue("Planning") as HTMLInputElement).value,
    ).toBe("Planning");
    fireEvent.click(screen.getByTestId("database-assistant-next"));
    fireEvent.click(screen.getByTestId("database-assistant-next"));

    expect(
      (await screen.findByTestId("database-assistant-review")).textContent,
    ).toContain("Release project");
    fireEvent.click(screen.getByTestId("database-assistant-create"));

    await waitFor(() => expect(props.onCreate).toHaveBeenCalledOnce());
    expect(props.onCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        templateId: PROJECT_TEMPLATE.id,
        title: "Release project",
        description: "Coordinate the release",
        folderId: null,
        includeSampleRows: true,
        priorityPreset: ProjectOptionPreset.FiveStep,
        complexityPreset: ProjectOptionPreset.FiveStep,
        structurePreset: ProjectStructurePreset.PhasesAndMilestones,
        assistantConfirmation: expect.objectContaining({
          planDigest: "fixture-canonical-plan",
          requestId: expect.any(String),
          locale: "en",
          clientVersion: 1,
          answers: expect.objectContaining({
            folder: {
              kind: "folder",
              value: { kind: "existing", id: "folder-1" },
            },
          }),
        }),
      }),
    );
    expect(props.onLinkFolder).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(props.onComplete).toHaveBeenCalledWith(
        "database-created",
        undefined,
        vi.mocked(props.onCreate).mock.calls[0][0].assistantConfirmation
          ?.requestId,
      ),
    );
  });

  test("disables unavailable samples and keeps them out of the payload", async () => {
    const props = renderAssistant();
    fireEvent.click(await screen.findByTestId("database-assistant-next"));
    fireEvent.change(screen.getByRole("textbox", { name: /^Description/ }), {
      target: { value: "A blank working database" },
    });
    fireEvent.click(screen.getByTestId("database-assistant-next"));

    expect(
      (screen.getByTestId("database-assistant-samples") as HTMLInputElement)
        .disabled,
    ).toBe(true);
    expect(
      screen.getByText("This template starts without sample rows.").textContent,
    ).toBe("This template starts without sample rows.");
    fireEvent.click(screen.getByTestId("database-assistant-next"));
    fireEvent.click(screen.getByTestId("database-assistant-create"));

    await waitFor(() => expect(props.onCreate).toHaveBeenCalledOnce());
    expect(props.onCreate).toHaveBeenCalledWith(
      expect.objectContaining({ includeSampleRows: false }),
    );
  });

  test("retains a lost acknowledgement under the exact request across remount and resumes without reprepare", async () => {
    const create = vi
      .fn()
      .mockRejectedValueOnce(new Error("acknowledgement lost"))
      .mockResolvedValue({ databaseId: "database-created" });
    const props = renderAssistant({ intent: "project", onCreate: create });
    await advanceToProjectReview();
    fireEvent.click(screen.getByTestId("database-assistant-create"));
    await screen.findByTestId("database-assistant-recovery");
    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    const request = create.mock.calls[0][0];
    expect(request.assistantConfirmation.requestId).toEqual(expect.any(String));
    expect(props.onComplete).not.toHaveBeenCalled();
    cleanup();
    assistantServer.status = ProjectSetupStatus.Pending;
    renderAssistant({ intent: "project", onCreate: create });
    const resume = await screen.findByRole("button", { name: "Resume setup" });
    await waitFor(() =>
      expect((resume as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(resume);
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    expect(create.mock.calls[1][0]).toEqual(request);
    expect(
      assistantServer.gql.mock.calls.filter(
        ([call]) => call.query === prepareProjectAssistantQuery,
      ),
    ).toHaveLength(1);
  });

  test("coalesces repeated submit activation while server creation is pending", async () => {
    let resolveCreate: ((result: { databaseId: string }) => void) | undefined;
    const create = vi.fn(
      () =>
        new Promise<{ databaseId: string }>((resolve) => {
          resolveCreate = resolve;
        }),
    );
    const complete = vi.fn();
    renderAssistant({
      intent: "project",
      onCreate: create,
      onComplete: complete,
    });
    await advanceToProjectReview();

    const submit = screen.getByTestId("database-assistant-create");
    fireEvent.click(submit);
    fireEvent.click(submit);
    await waitFor(() => expect(create).toHaveBeenCalledOnce());

    resolveCreate?.({ databaseId: "database-created" });
    await waitFor(() =>
      expect(complete).toHaveBeenCalledWith(
        "database-created",
        undefined,
        expect.any(String),
      ),
    );
  });

  test("a deleted accepted Project result needs durable Gone acknowledgement and explicit new setup before a fresh request key", async () => {
    assistantServer.status = ProjectSetupStatus.Pending;
    const callbacks = createCallbacks();
    renderAssistant({ intent: "project", ...callbacks });
    await advanceToProjectReview();
    fireEvent.click(screen.getByTestId("database-assistant-create"));
    await screen.findByRole("button", { name: "Resume setup" });
    await waitFor(() => expect(callbacks.onCreate).toHaveBeenCalledOnce());
    const original = structuredClone(callbacks.onCreate.mock.calls[0][0]);
    const key =
      "project-setup:pending:" +
      JSON.stringify(["server", "actor", "workspace"]);
    const normal = assistantServer.gql.getMockImplementation()!;
    assistantServer.gql.mockImplementation(async (input) => {
      if (
        input.query === projectSetupQuery &&
        input.variables.requestId === original.assistantConfirmation.requestId
      )
        throw new GraphQLError("deleted result", {
          extensions: { code: "MIX_ASSISTANT_RESULT_GONE" },
        });
      return normal(input);
    });
    cleanup();
    callbacks.onCreate.mockClear();
    assistantServer.gql.mockClear();
    renderAssistant({ intent: "project", ...callbacks });
    await screen.findByRole("button", { name: "Start a new setup" });
    expect(screen.queryByRole("button", { name: "Resume setup" })).toBeNull();
    expect(assistantServer.storage.get(key)).toEqual({
      request: original,
      gone: true,
    });
    expect(callbacks.onCreate).not.toHaveBeenCalled();
    expect(
      assistantServer.gql.mock.calls.some(
        ([input]) => input.query === prepareProjectAssistantQuery,
      ),
    ).toBe(false);
    cleanup();
    assistantServer.gql.mockClear();
    renderAssistant({ intent: "project", ...callbacks });
    fireEvent.click(
      await screen.findByRole("button", { name: "Start a new setup" }),
    );
    await screen.findByTestId("database-assistant-next");
    expect(assistantServer.storage.has(key)).toBe(false);
    expect(callbacks.onCreate).not.toHaveBeenCalled();
    expect(
      assistantServer.gql.mock.calls.some(
        ([input]) =>
          input.query === projectSetupQuery ||
          input.query === prepareProjectAssistantQuery,
      ),
    ).toBe(false);
    assistantServer.status = ProjectSetupStatus.Ready;
    await advanceToProjectReview();
    fireEvent.click(screen.getByTestId("database-assistant-create"));
    await waitFor(() => expect(callbacks.onCreate).toHaveBeenCalledOnce());
    expect(
      callbacks.onCreate.mock.calls[0][0].assistantConfirmation.requestId,
    ).not.toBe(original.assistantConfirmation.requestId);
  });

  test("a rejected durable write never sends create and retains the exact request for explicit retry", async () => {
    assistantServer.persist.mockRejectedValueOnce(new Error("flush failed"));
    const props = renderAssistant({ intent: "project" });
    await advanceToProjectReview();
    fireEvent.click(screen.getByTestId("database-assistant-create"));
    await screen.findByRole("button", { name: "Resume setup" });
    await screen.findByText("Creation failed");
    expect(props.onCreate).not.toHaveBeenCalled();
    expect(assistantServer.storage.size).toBe(0);
    const frozen = assistantServer.persist.mock.calls[0][1];
    fireEvent.click(screen.getByRole("button", { name: "Resume setup" }));
    await waitFor(() => expect(props.onCreate).toHaveBeenCalledOnce());
    expect(props.onCreate).toHaveBeenCalledWith(frozen.request);
  });

  test("an account change while durable storage is pending prevents the old request RPC", async () => {
    let acknowledge: (() => void) | undefined;
    assistantServer.persist.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          acknowledge = resolve;
        }),
    );
    const props = renderAssistant({ intent: "project" });
    await advanceToProjectReview();
    fireEvent.click(screen.getByTestId("database-assistant-create"));
    await waitFor(() => expect(assistantServer.persist).toHaveBeenCalledOnce());
    assistantServer.account?.next({ id: "other-actor" });
    acknowledge?.();
    await waitFor(() => expect(assistantServer.storage.size).toBe(1));
    expect(props.onCreate).not.toHaveBeenCalled();
    expect(props.onComplete).not.toHaveBeenCalled();
  });

  test("only explicit re-confirmation refreshes native transport while retaining the accepted user fingerprint", async () => {
    const create = vi
      .fn()
      .mockRejectedValueOnce(new Error("lost acknowledgement"))
      .mockResolvedValue({ databaseId: "database-created" });
    renderAssistant({ intent: "project", onCreate: create });
    await advanceToProjectReview();
    fireEvent.click(screen.getByTestId("database-assistant-create"));
    await screen.findByRole("button", { name: "Resume setup" });
    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    const original = structuredClone(create.mock.calls[0][0]);
    if (!assistantServer.plan)
      throw new Error("Expected canonical initial preparation");
    assistantServer.currentReview = {
      ...assistantServer.plan,
      planDigest: "reviewed-current-effects",
      title: "Reviewed native title",
      description: "Reviewed native description",
      templateId: "myoxus.project.simple_project",
      templateVersion: "1.0.1",
      priority: ProjectOptionPreset.FiveStep,
      complexity: ProjectOptionPreset.FiveStep,
      structure: ProjectStructurePreset.TasksOnly,
      includeSampleRows: false,
    };
    assistantServer.status = ProjectSetupStatus.ReReviewRequired;
    const check = screen.getByRole("button", { name: "Check status" });
    await waitFor(() =>
      expect((check as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(check);
    const confirm = await screen.findByRole("button", {
      name: "Confirm reviewed changes and resume",
    });
    await waitFor(() =>
      expect((confirm as HTMLButtonElement).disabled).toBe(false),
    );
    expect(
      screen.getByTestId("database-assistant-current-review").textContent,
    ).toContain("Reviewed native title");
    expect(create).toHaveBeenCalledOnce();
    fireEvent.click(confirm);
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    const updated = create.mock.calls[1][0];
    expect(updated).toEqual({
      ...original,
      title: "Reviewed native title",
      description: "Reviewed native description",
      templateId: "myoxus.project.simple_project",
      priorityPreset: ProjectOptionPreset.FiveStep,
      complexityPreset: ProjectOptionPreset.FiveStep,
      structurePreset: ProjectStructurePreset.TasksOnly,
      includeSampleRows: false,
      folderId: null,
      assistantConfirmation: {
        ...original.assistantConfirmation,
        admissionConfirmation: "reviewed-current-effects",
      },
    });
    expect(updated.assistantConfirmation.answers).toEqual(
      original.assistantConfirmation.answers,
    );
    expect(updated.assistantConfirmation.requestId).toBe(
      original.assistantConfirmation.requestId,
    );
  });

  test("completes all four steps and Cancel with keyboard controls", async () => {
    const user = userEvent.setup();
    const complete = vi.fn();
    const openChange = vi.fn();
    renderAssistant({
      intent: "project",
      onComplete: complete,
      onOpenChange: openChange,
      templates: [
        PROJECT_TEMPLATE,
        {
          ...PROJECT_TEMPLATE,
          id: "server-project-2",
          name: "Second project",
          nameKey: "server.project.second.name",
          descriptionKey: "server.project.second.description",
        },
      ],
    });

    const first = await screen.findByRole("radio", {
      name: /Simple project/i,
    });
    first.focus();
    await user.keyboard("{ArrowRight}");
    expect(
      screen
        .getByRole("radio", { name: /Product roadmap/i })
        .getAttribute("aria-checked"),
    ).toBe("true");
    screen.getByTestId("database-assistant-next").focus();
    await user.keyboard("{Enter}");

    const name = screen.getByRole("textbox", { name: /^Project name/ });
    name.focus();
    await user.keyboard("{Control>}a{/Control}Keyboard project");
    const description = screen.getByRole("textbox", { name: /^Description/ });
    description.focus();
    await user.keyboard("Keyboard-created project overview");
    const folder = screen.getByRole("combobox", { name: "Folder" });
    folder.focus();
    await user.keyboard("{ArrowDown}{Enter}");
    screen.getByTestId("database-assistant-next").focus();
    await user.keyboard("{Enter}");
    screen.getByTestId("database-assistant-next").focus();
    await user.keyboard("{Enter}");
    (await screen.findByTestId("database-assistant-create")).focus();
    await user.keyboard("{Enter}");

    await waitFor(() =>
      expect(complete).toHaveBeenCalledWith(
        "database-created",
        undefined,
        expect.any(String),
      ),
    );

    cleanup();
    renderAssistant({ intent: "project", onOpenChange: openChange });
    const cancel = await screen.findByRole("button", { name: "Cancel" });
    cancel.focus();
    await user.keyboard("{Enter}");
    expect(openChange).toHaveBeenCalledWith(false);
  });
});
