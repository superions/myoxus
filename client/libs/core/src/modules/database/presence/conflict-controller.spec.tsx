// SPDX-License-Identifier: AGPL-3.0-or-later
/** @vitest-environment happy-dom */

import { GraphQLError, UserFriendlyError } from "@myoxus/error";
import { Button } from "@myoxus/ui-facade";
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
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import {
  PropertySymbol,
  type Document as HappyDocument,
  type Window as HappyWindow,
} from "happy-dom";

import {
  databaseConflictDetails,
  DatabaseConflictProvider,
  useDatabaseConflictController,
} from "./conflict-controller";

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

// Vitest aliases window to Node's global. Mantine transitions must use the
// actual DOM timer owner so the fixture's drain also covers their callbacks.
beforeAll(() => {
  Object.assign(
    globalThis,
    Object.fromEntries(
      timerNames.map((name) => [name, browserWindow[name].bind(browserWindow)]),
    ),
  );
});
afterAll(() => {
  Object.assign(globalThis, originalTimers);
});

vi.mock("@myoxus/i18n", () => ({
  useI18n: () =>
    new Proxy(
      {},
      {
        get: (_target, key) => () => String(key),
      },
    ),
}));

const conflict = {
  extensions: {
    code: "MIX_DATABASE_CELL_CONFLICT",
    latestState: JSON.stringify({
      kind: "cell",
      databaseId: "database-1",
      rowId: "row-1",
      fieldId: "field-1",
      editRevision: 2,
      value: { text: "Remote" },
    }),
  },
};

function ConflictProbe({
  allowOverwrite,
  mutate,
  reloadLatest,
}: {
  allowOverwrite?: boolean;
  mutate: (force: boolean) => Promise<unknown>;
  reloadLatest: () => Promise<void>;
}) {
  const controller = useDatabaseConflictController();
  return (
    <Button
      onClick={() =>
        void controller.execute({
          allowOverwrite,
          attemptedAction: "Notes",
          localValue: "Local",
          mutate,
          reloadLatest,
        })
      }
    >
      Save
    </Button>
  );
}

function renderProbe(
  mutate: (force: boolean) => Promise<unknown>,
  reloadLatest = vi.fn(async () => {}),
  allowOverwrite?: boolean,
) {
  render(
    <MyoxusUIProvider env="test">
      <DatabaseConflictProvider>
        <ConflictProbe
          allowOverwrite={allowOverwrite}
          mutate={mutate}
          reloadLatest={reloadLatest}
        />
      </DatabaseConflictProvider>
    </MyoxusUIProvider>,
  );
  return { reloadLatest };
}

beforeEach(() => {
  // Exercise the native reduced-motion boundary only in this fixture: transition
  // hooks must finish before happy-dom retires their Window.
  const matchMedia = window.matchMedia.bind(window);
  vi.spyOn(window, "matchMedia").mockImplementation((query) => {
    const media = matchMedia(query);
    if (query === "(prefers-reduced-motion: reduce)") {
      Object.defineProperty(media, "matches", { value: true });
    }
    return media;
  });
});

afterEach(async () => {
  // Finish asynchronous recovery and its transitions while the fixture is still
  // mounted; unmounting first can leave a late React transition in a dead Window.
  const finishDOMTasks = () =>
    (
      window as unknown as {
        happyDOM: { waitUntilComplete(): Promise<void> };
      }
    ).happyDOM.waitUntilComplete();
  await act(finishDOMTasks);
  cleanup();
  await finishDOMTasks();
  vi.restoreAllMocks();
});

describe("Database conflict controller", () => {
  test("recognizes only the stable Database conflict family", () => {
    expect(databaseConflictDetails(conflict)).toEqual({
      code: "MIX_DATABASE_CELL_CONFLICT",
      latestStateJson: conflict.extensions.latestState,
    });
    expect(
      databaseConflictDetails({ extensions: { code: "OTHER" } }),
    ).toBeNull();
  });

  test("recognizes conflict metadata after GraphQL service normalization", () => {
    const normalized = UserFriendlyError.fromAny(
      new GraphQLError("database cell changed", conflict),
    );

    expect(databaseConflictDetails(normalized)).toEqual({
      code: "MIX_DATABASE_CELL_CONFLICT",
      latestStateJson: conflict.extensions.latestState,
    });
  });

  test("never retries with force until the user explicitly chooses overwrite", async () => {
    const mutate = vi
      .fn<(force: boolean) => Promise<unknown>>()
      .mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce({ ok: true });
    renderProbe(mutate);

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByTestId("database-conflict-modal")).not.toBeNull();
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate).toHaveBeenLastCalledWith(false);

    fireEvent.click(
      screen.getByRole("button", {
        name: "com.myoxus.database.conflict.overwrite",
      }),
    );
    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(2));
    expect(mutate).toHaveBeenLastCalledWith(true);
  });

  test("reload invokes only the conflicting editor callback and does not force", async () => {
    const mutate = vi
      .fn<(force: boolean) => Promise<unknown>>()
      .mockRejectedValue(conflict);
    const { reloadLatest } = renderProbe(mutate);

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(
      await screen.findByRole("button", {
        name: "com.myoxus.database.conflict.reload",
      }),
    );
    await waitFor(() => expect(reloadLatest).toHaveBeenCalledOnce());
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate).toHaveBeenCalledWith(false);
  });

  test("a disposed scoped read cannot reopen private conflict previews after dismissal", async () => {
    let current = true;
    let completeRead!: (value: string) => void;
    const readServerValue = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          completeRead = resolve;
        }),
    );
    const mutate = vi.fn(async () => {
      throw conflict;
    });
    function ScopedProbe() {
      const controller = useDatabaseConflictController();
      return (
        <>
          <Button
            onClick={() =>
              void controller.execute({
                scope: "old-actor-row",
                canOverwrite: () => current,
                attemptedAction: "Blocked by",
                localValue: "Private attempted prerequisite",
                readServerValue,
                mutate,
                reloadLatest: async () => {},
              })
            }
          >
            Save scoped
          </Button>
          <Button
            onClick={() => {
              current = false;
              controller.dismiss?.("old-actor-row");
            }}
          >
            Lose access
          </Button>
        </>
      );
    }
    render(
      <MyoxusUIProvider env="test">
        <DatabaseConflictProvider>
          <ScopedProbe />
        </DatabaseConflictProvider>
      </MyoxusUIProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Save scoped" }));
    await waitFor(() => expect(readServerValue).toHaveBeenCalledOnce());
    expect(readServerValue).toHaveBeenCalledWith(
      databaseConflictDetails(conflict),
    );
    fireEvent.click(screen.getByRole("button", { name: "Lose access" }));
    await act(async () => {
      completeRead("Private latest prerequisite");
    });
    expect(screen.queryByTestId("database-conflict-modal")).toBeNull();
    expect(screen.queryByText("Private attempted prerequisite")).toBeNull();
    expect(screen.queryByText("Private latest prerequisite")).toBeNull();
    expect(mutate).toHaveBeenCalledExactlyOnceWith(false);
  });

  test("hides overwrite for atomic mutations that forbid forced retries", async () => {
    const mutate = vi
      .fn<(force: boolean) => Promise<unknown>>()
      .mockRejectedValue(conflict);
    const reloadLatest = vi.fn(async () => {});
    renderProbe(mutate, reloadLatest, false);

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByTestId("database-conflict-modal")).not.toBeNull();
    expect(
      screen.queryByRole("button", {
        name: "com.myoxus.database.conflict.overwrite",
      }),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole("button", {
        name: "com.myoxus.database.conflict.reload",
      }),
    );
    await waitFor(() => expect(reloadLatest).toHaveBeenCalledOnce());
    expect(mutate).toHaveBeenCalledExactlyOnceWith(false);
  });
});

test("native Row-template conflicts offer reload without a forced retry", async () => {
  const error = {
    extensions: {
      code: "MIX_DATABASE_CONFLICT",
      latestState: JSON.stringify({
        kind: "rowTemplate",
        databaseId: "database-1",
        rowTemplateId: "template-1",
        editRevision: 3,
        name: "Task",
        initialCellValues: [{ fieldId: "notes", value: "Remote seed" }],
      }),
    },
  };
  const mutate = vi.fn(async () => {
    throw error;
  });
  const reload = vi.fn(async () => {});
  renderProbe(mutate, reload, false);
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  const dialog = await screen.findByTestId("database-conflict-modal");
  expect(dialog.textContent).toContain("Remote seed");
  expect(
    screen.queryByRole("button", {
      name: "com.myoxus.database.conflict.overwrite",
    }),
  ).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: "com.myoxus.database.conflict.reload" }),
  );
  await waitFor(() => expect(reload).toHaveBeenCalledOnce());
  expect(mutate).toHaveBeenCalledExactlyOnceWith(false);
});
