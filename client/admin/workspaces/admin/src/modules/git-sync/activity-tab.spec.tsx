/**
 * @vitest-environment happy-dom
 */
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import { notify } from "@myoxus/ui-facade";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import { Activity, type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import enJson from "../../../../../../libs/i18n/src/resources/en.json";

const en: Record<string, string> = enJson;
const useQueryMock = vi.fn();
const mutationTriggers: Record<string, ReturnType<typeof vi.fn>> = {};
const revalidateMock = vi.fn().mockResolvedValue(undefined);
const queryMutateMock = vi.fn().mockResolvedValue(undefined);
const clipboardWriteMock = vi.fn().mockResolvedValue(undefined);

function translate(key: string, options?: Record<string, unknown>) {
  let text = en[key] ?? key;
  for (const [name, value] of Object.entries(options ?? {})) {
    text = text.replace(new RegExp(`\\{\\{${name}\\}\\}`, "g"), String(value));
  }
  return text;
}

vi.mock("@myoxus/i18n", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    useI18n: () => ({
      "com.myoxus.peek-view-controls.close": () =>
        en["com.myoxus.peek-view-controls.close"],
      t: translate,
      exists: (key: string) => key in en,
      language: "en",
      changeLanguage: () => Promise.resolve(),
    }),
  };
});

vi.mock("../../components/domain-pickers", () => ({
  WorkspacePicker: ({
    onChange,
    disabled,
    label,
  }: {
    onChange: (workspaceId: string) => void;
    disabled?: boolean;
    label?: string;
  }) => (
    <div>
      <span>{label}</span>
      <button
        type="button"
        disabled={disabled}
        onClick={() => onChange("workspace-alpha")}
      >
        Select Alpha
      </button>
    </div>
  ),
}));

vi.mock("../../use-query", () => ({
  useQuery: (options?: { query?: { id: string }; variables?: unknown }) =>
    useQueryMock(options),
}));

vi.mock("../../use-mutation", () => ({
  useMutation: ({ mutation }: { mutation: { id: string } }) => {
    if (!mutationTriggers[mutation.id]) {
      mutationTriggers[mutation.id] = vi.fn().mockResolvedValue({
        resolveGitSyncConflict: true,
        resolveGitSyncFileConflict: true,
      });
    }
    return { trigger: mutationTriggers[mutation.id], isMutating: false };
  },
  useMutateQueryResource: () => revalidateMock,
}));

import { ActivityTab } from "./activity-tab";

function renderWithProvider(node: ReactElement) {
  return render(<MyoxusUIProvider>{node}</MyoxusUIProvider>);
}

async function openConflict(kind: "document" | "file") {
  fireEvent.click(
    screen.getByRole("button", {
      name: kind === "document" ? /docs\/handbook.md/ : /assets\/logo.png/,
    }),
  );
  if (kind === "document") await screen.findByLabelText("Manual merge content");
  else await screen.findByText("Git git-sha · Myoxus myoxus-sha");
}

function queryResult(queryId?: string) {
  switch (queryId) {
    case "getGitSyncStatusQuery":
      return {
        data: {
          workspace: {
            gitSyncStatus: {
              openDocConflicts: 1,
              openFileConflicts: 1,
              totalDocBindings: 2,
              totalFileBindings: 3,
              partialSessionId: "partial-1",
              partialStatus: "Open",
              partialHasMore: true,
              partialTotalItems: 10,
              partialProcessedItems: 4,
              partialFailedItems: 1,
            },
          },
        },
        isLoading: false,
      };
    case "getGitSyncRunsQuery":
      return {
        data: {
          workspace: {
            gitSyncRuns: [
              {
                id: "run-1",
                direction: "Bidirectional",
                triggerSource: "Manual",
                status: "Completed",
                startedAt: "2026-06-05T10:00:00Z",
                finishedAt: "2026-06-05T10:00:10Z",
                jobId: "completed-job",
                commitBefore: "1111111111111111111111111111111111111111",
                commitAfter: "2222222222222222222222222222222222222222",
                observedRemoteOid: "2222222222222222222222222222222222222222",
                reconciliationRequired: false,
                reconciliationReason: null,
                docsCreated: 1,
                docsUpdated: 2,
                docsDeleted: 0,
                conflictsFound: 1,
                errorMessage: null,
                errorClass: null,
              },
              {
                id: "run-2",
                direction: "MyoxusToGit",
                triggerSource: "Polling",
                status: "Failed",
                startedAt: "2026-06-05T09:00:00Z",
                finishedAt: "2026-06-05T09:00:05Z",
                jobId: "pre-push-job",
                commitBefore: "2222222222222222222222222222222222222222",
                commitAfter: null,
                observedRemoteOid: null,
                reconciliationRequired: false,
                reconciliationReason: null,
                docsCreated: 0,
                docsUpdated: 0,
                docsDeleted: 0,
                conflictsFound: 0,
                errorMessage: "remote unavailable",
                errorClass: "GitNetwork",
              },
              {
                id: "run-3",
                direction: "GitToMyoxus",
                triggerSource: "Webhook",
                status: "Failed",
                startedAt: "2026-06-05T08:00:00Z",
                finishedAt: "2026-06-05T08:00:05Z",
                jobId: "reconciliation-job",
                commitBefore: "2222222222222222222222222222222222222222",
                commitAfter: null,
                observedRemoteOid: "3333333333333333333333333333333333333333",
                reconciliationRequired: true,
                reconciliationReason:
                  "remote moved; database finalization rolled back",
                docsCreated: 5,
                docsUpdated: 6,
                docsDeleted: 7,
                conflictsFound: 1,
                errorMessage: "reconciliation required",
                errorClass: "InternalError",
              },
            ],
          },
        },
        isLoading: false,
      };
    case "getGitSyncConflictsQuery":
      return {
        data: {
          workspace: {
            gitSyncConflicts: [
              {
                id: "doc-conflict-1",
                repoPath: "docs/handbook.md",
                conflictType: "BothModified",
                resolution: "Open",
                myoxusContent: "Myoxus paragraph",
                gitContent: "Git paragraph",
                createdAt: "2026-06-05T09:00:00Z",
              },
            ],
          },
        },
        isLoading: false,
      };
    case "getGitSyncFileConflictsQuery":
      return {
        data: {
          workspace: {
            gitSyncFileConflicts: [
              {
                id: "file-conflict-1",
                runId: "run-1",
                bindingId: "binding-file-1",
                blobKey: "blob-1",
                repoPath: "assets/logo.png",
                conflictType: "BothModified",
                resolution: "Open",
                gitHash: "git-sha",
                myoxusHash: "myoxus-sha",
                baselineHash: "base-sha",
                createdAt: "2026-06-05T09:10:00Z",
                resolvedAt: null,
                resolvedBy: null,
              },
            ],
          },
        },
        isLoading: false,
      };
    case "getGitSyncBindingsQuery":
      return {
        data: {
          workspace: {
            gitSyncBindings: [
              {
                id: "binding-doc-1",
                docId: "doc-1",
                syncId: "sync-1",
                repoPath: "docs/a.md",
                tombstone: false,
              },
              {
                id: "binding-doc-2",
                docId: "doc-2",
                syncId: "sync-2",
                repoPath: "docs/b.md",
                tombstone: false,
              },
            ],
          },
        },
        isLoading: false,
      };
    case "getGitSyncFileBindingsQuery":
      return {
        data: {
          workspace: {
            gitSyncFileBindings: [
              {
                id: "binding-file-1",
                blobKey: "blob-1",
                repoPath: "assets/logo.png",
                contentHash: "sha",
                mimeType: "image/png",
                fileSize: 42,
                tombstoned: false,
                createdAt: "2026-06-05T08:00:00Z",
                updatedAt: "2026-06-05T08:00:00Z",
              },
              {
                id: "binding-file-2",
                blobKey: "blob-2",
                repoPath: "assets/archive.zip",
                contentHash: "sha2",
                mimeType: "application/zip",
                fileSize: 84,
                tombstoned: true,
                createdAt: "2026-06-05T08:00:00Z",
                updatedAt: "2026-06-05T08:00:00Z",
              },
              {
                id: "binding-file-3",
                blobKey: "blob-3",
                repoPath: "assets/photo.jpg",
                contentHash: "sha3",
                mimeType: "image/jpeg",
                fileSize: 128,
                tombstoned: false,
                createdAt: "2026-06-05T08:00:00Z",
                updatedAt: "2026-06-05T08:00:00Z",
              },
            ],
          },
        },
        isLoading: false,
      };
    default:
      return { data: undefined, isLoading: false };
  }
}

describe("ActivityTab", () => {
  beforeEach(() => {
    cleanup();
    notify.dismiss();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: clipboardWriteMock },
    });
    useQueryMock.mockImplementation((options?: { query?: { id: string } }) => ({
      ...queryResult(options?.query?.id),
      mutate: queryMutateMock,
    }));
    revalidateMock.mockReset().mockResolvedValue(undefined);
    queryMutateMock.mockReset().mockResolvedValue(undefined);
    clipboardWriteMock.mockClear();
    for (const key of Object.keys(mutationTriggers))
      delete mutationTriggers[key];
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  test("starts with an explicit workspace-scoped empty state", () => {
    renderWithProvider(<ActivityTab />);
    expect(
      screen.getByText("Select a workspace to inspect Git Sync runtime state."),
    ).toBeTruthy();
    expect(useQueryMock).toHaveBeenCalledWith(undefined);
  });

  test("renders mixed doc/file/partial runtime state after workspace selection", async () => {
    renderWithProvider(<ActivityTab />);
    fireEvent.click(screen.getByRole("button", { name: "Select Alpha" }));
    await openConflict("document");
    await openConflict("file");
    fireEvent.click(
      screen.getAllByRole("button", { name: "Technical details" })[0],
    );

    expect(screen.getByText("docs/handbook.md")).toBeTruthy();
    expect(screen.getByText("assets/logo.png")).toBeTruthy();
    expect(screen.getByText("Myoxus paragraph")).toBeTruthy();
    expect(screen.getByText("Git git-sha · Myoxus myoxus-sha")).toBeTruthy();
    expect(
      screen.getByText(
        "Partial session Open: 4 / 10 processed, 1 failed. More items are pending.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText("2 document bindings · 3 file bindings"),
    ).toBeTruthy();
    expect(await screen.findByText("+1 / ~2 / -0 / 1 conflicts")).toBeTruthy();
  });

  test("distinguishes finalized, pre-push and applied-but-unfinalized runs", async () => {
    renderWithProvider(<ActivityTab />);
    fireEvent.click(screen.getByRole("button", { name: "Select Alpha" }));

    expect(screen.getByText("Bidirectional · Manual")).toBeTruthy();
    expect(screen.getByText("Push (Myoxus to Git) · Polling")).toBeTruthy();
    expect(screen.getByText("Pull (Git to Myoxus) · Webhook")).toBeTruthy();
    expect(
      screen.getByText("Remote change requires reconciliation"),
    ).toBeTruthy();
    expect(
      screen.getByText(
        /The remote branch moved.*remote moved; database finalization rolled back/,
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/nothing changed/i)).toBeNull();

    fireEvent.click(
      screen.getAllByRole("button", { name: "Technical details" })[2],
    );
    expect(await screen.findByText("+5 / ~6 / -7 / 1 conflicts")).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: "Copy: Observed remote OID" }),
    );
    await waitFor(() =>
      expect(clipboardWriteMock).toHaveBeenCalledWith(
        "3333333333333333333333333333333333333333",
      ),
    );
  });

  test("binding query failure remains scoped and reloads every activity resource", async () => {
    useQueryMock.mockImplementation((options?: { query?: { id: string } }) => ({
      ...queryResult(options?.query?.id),
      error:
        options?.query?.id === "getGitSyncBindingsQuery"
          ? new Error("raw binding payload")
          : undefined,
      mutate: queryMutateMock,
    }));
    renderWithProvider(<ActivityTab />);
    fireEvent.click(screen.getByRole("button", { name: "Select Alpha" }));

    expect(screen.getByText("Configuration needs attention")).toBeTruthy();
    expect(screen.queryByText("raw binding payload")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Reload server values" }),
    );
    await waitFor(() => expect(queryMutateMock).toHaveBeenCalledTimes(6));
  });

  test("semantic document conflict resolution sends server payload and revalidates runtime queries", async () => {
    renderWithProvider(<ActivityTab />);
    fireEvent.click(screen.getByRole("button", { name: "Select Alpha" }));
    await openConflict("document");
    fireEvent.click(screen.getAllByRole("button", { name: "Myoxus wins" })[0]);
    expect(
      mutationTriggers.resolveGitSyncConflictMutation,
    ).not.toHaveBeenCalled();
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Confirm",
      }),
    );

    await waitFor(() => {
      expect(
        mutationTriggers.resolveGitSyncConflictMutation,
      ).toHaveBeenCalledWith({
        input: {
          conflictId: "doc-conflict-1",
          resolution: "MyoxusWins",
          mergedContent: undefined,
        },
      });
    });
    expect(revalidateMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: "getGitSyncStatusQuery" }),
      expect.any(Function),
    );
    expect(revalidateMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: "getGitSyncConflictsQuery" }),
      expect.any(Function),
    );
  });

  test("manual merge requires content and then sends mergedContent", async () => {
    renderWithProvider(<ActivityTab />);
    fireEvent.click(screen.getByRole("button", { name: "Select Alpha" }));
    await openConflict("document");

    const manualButton = screen.getByRole("button", {
      name: "Apply manual merge",
    });
    expect((manualButton as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Manual merge content"), {
      target: { value: "Merged markdown" },
    });
    expect((manualButton as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(manualButton);
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Confirm",
      }),
    );

    await waitFor(() => {
      expect(
        mutationTriggers.resolveGitSyncConflictMutation,
      ).toHaveBeenCalledWith({
        input: {
          conflictId: "doc-conflict-1",
          resolution: "ManualMerge",
          mergedContent: "Merged markdown",
        },
      });
    });
  });

  test("file conflict resolution calls the file-specific mutation", async () => {
    renderWithProvider(<ActivityTab />);
    fireEvent.click(screen.getByRole("button", { name: "Select Alpha" }));
    await openConflict("file");
    fireEvent.click(screen.getByRole("button", { name: "Git wins" }));
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Confirm",
      }),
    );

    await waitFor(() => {
      expect(
        mutationTriggers.resolveGitSyncFileConflictMutation,
      ).toHaveBeenCalledWith({
        input: {
          conflictId: "file-conflict-1",
          resolution: "GitWins",
        },
      });
    });
    expect(revalidateMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: "getGitSyncFileConflictsQuery" }),
      expect.any(Function),
    );
  });

  test("cancel never writes and the merge survives Activity hiding and disclosure closure", async () => {
    function Harness({ visible }: { visible: boolean }) {
      return (
        <Activity mode={visible ? "visible" : "hidden"}>
          <ActivityTab />
        </Activity>
      );
    }
    const view = renderWithProvider(<Harness visible />);
    fireEvent.click(screen.getByRole("button", { name: "Select Alpha" }));
    await openConflict("document");
    fireEvent.change(screen.getByLabelText("Manual merge content"), {
      target: { value: "Retained draft" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply manual merge" }));
    expect((await screen.findByRole("dialog")).textContent).toContain(
      "workspace-alpha",
    );
    expect((await screen.findByRole("dialog")).textContent).toContain(
      "docs/handbook.md",
    );
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Cancel",
      }),
    );
    expect(
      mutationTriggers.resolveGitSyncConflictMutation,
    ).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: /docs\/handbook.md/ }));
    view.rerender(
      <MyoxusUIProvider>
        <Harness visible={false} />
      </MyoxusUIProvider>,
    );
    view.rerender(
      <MyoxusUIProvider>
        <Harness visible />
      </MyoxusUIProvider>,
    );
    await openConflict("document");
    expect(
      (screen.getByLabelText("Manual merge content") as HTMLTextAreaElement)
        .value,
    ).toBe("Retained draft");
    expect(
      (
        screen.getByRole("button", {
          name: "Select Alpha",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Reset" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Cancel",
      }),
    );
    expect(
      (screen.getByLabelText("Manual merge content") as HTMLTextAreaElement)
        .value,
    ).toBe("Retained draft");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    fireEvent.click(await screen.findByTestId("admin-confirm-modal-confirm"));
    expect(
      (screen.getByLabelText("Manual merge content") as HTMLTextAreaElement)
        .value,
    ).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(
      screen.getByText("Select a workspace to inspect Git Sync runtime state."),
    ).toBeTruthy();
    expect(
      mutationTriggers.resolveGitSyncConflictMutation,
    ).not.toHaveBeenCalled();
  });

  test("a conflict removed during confirmation cannot be written", async () => {
    const view = renderWithProvider(<ActivityTab />);
    fireEvent.click(screen.getByRole("button", { name: "Select Alpha" }));
    await openConflict("document");
    fireEvent.click(screen.getByRole("button", { name: "Git wins" }));
    useQueryMock.mockImplementation((options?: { query?: { id: string } }) => ({
      ...(options?.query?.id === "getGitSyncConflictsQuery"
        ? { data: { workspace: { gitSyncConflicts: [] } }, isLoading: false }
        : queryResult(options?.query?.id)),
      mutate: queryMutateMock,
    }));
    view.rerender(
      <MyoxusUIProvider>
        <ActivityTab />
      </MyoxusUIProvider>,
    );
    fireEvent.click(await screen.findByTestId("admin-confirm-modal-confirm"));
    expect(
      mutationTriggers.resolveGitSyncConflictMutation,
    ).not.toHaveBeenCalled();
    expect(
      screen.getByText(/This conflict is no longer available/).textContent,
    ).toContain("selected workspace");
  });

  test.each(["negative"])(
    "%s acknowledgement keeps the draft and exposes a scrubbed dialog error",
    async (result) => {
      renderWithProvider(<ActivityTab />);
      fireEvent.click(screen.getByRole("button", { name: "Select Alpha" }));
      await openConflict("document");
      fireEvent.change(screen.getByLabelText("Manual merge content"), {
        target: { value: "Retained draft" },
      });
      if (result === "negative")
        mutationTriggers.resolveGitSyncConflictMutation.mockResolvedValue({
          resolveGitSyncConflict: false,
        });
      else
        mutationTriggers.resolveGitSyncConflictMutation.mockRejectedValue(
          new Error("forbidden: raw document payload"),
        );
      fireEvent.click(
        screen.getByRole("button", { name: "Apply manual merge" }),
      );
      fireEvent.click(await screen.findByTestId("admin-confirm-modal-confirm"));
      await waitFor(() =>
        expect(
          within(screen.getByRole("dialog")).getByText(
            /The conflict could not be resolved/,
          ).textContent,
        ).toContain("Your manual merge is retained."),
      );
      expect(revalidateMock).not.toHaveBeenCalled();
      expect(screen.queryByText("forbidden: raw document payload")).toBeNull();
      fireEvent.click(await screen.findByTestId("admin-confirm-modal-cancel"));
      expect(
        (screen.getByLabelText("Manual merge content") as HTMLTextAreaElement)
          .value,
      ).toBe("Retained draft");
    },
  );

  test("busy ownership lasts through readback and all invalidations match only the confirmed workspace", async () => {
    let completeReadback!: () => void;
    const readback = new Promise<void>((resolve) => {
      completeReadback = resolve;
    });
    revalidateMock.mockImplementation(() => readback);
    renderWithProvider(<ActivityTab />);
    fireEvent.click(screen.getByRole("button", { name: "Select Alpha" }));
    await openConflict("file");
    fireEvent.click(screen.getByRole("button", { name: "Git wins" }));
    fireEvent.click(await screen.findByTestId("admin-confirm-modal-confirm"));
    await waitFor(() => expect(revalidateMock).toHaveBeenCalledTimes(6));
    expect(
      (
        screen.getByRole("button", {
          name: "Select Alpha",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Git wins" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    for (const [, matchesOwner] of revalidateMock.mock.calls) {
      expect(matchesOwner({ workspaceId: "workspace-alpha" })).toBe(true);
      expect(matchesOwner({ workspaceId: "workspace-beta" })).toBe(false);
    }
    completeReadback();
    await waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: "Select Alpha",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    expect(
      mutationTriggers.resolveGitSyncFileConflictMutation,
    ).toHaveBeenCalledOnce();
  });

  test("an applied write with failed readback locks actions until read-only reload succeeds", async () => {
    revalidateMock.mockRejectedValue(new Error("raw credential-like payload"));
    renderWithProvider(<ActivityTab />);
    fireEvent.click(screen.getByRole("button", { name: "Select Alpha" }));
    await openConflict("file");
    fireEvent.click(screen.getByRole("button", { name: "Myoxus wins" }));
    fireEvent.click(await screen.findByTestId("admin-confirm-modal-confirm"));
    await waitFor(() =>
      expect(screen.getByText(/The conflict action was applied/)).toBeTruthy(),
    );
    expect(screen.queryByText("raw credential-like payload")).toBeNull();
    expect(
      (screen.getByRole("button", { name: "Myoxus wins" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    revalidateMock.mockResolvedValue(undefined);
    fireEvent.click(
      screen.getByRole("button", { name: "Reload server values" }),
    );
    await waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: "Myoxus wins",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    expect(
      mutationTriggers.resolveGitSyncFileConflictMutation,
    ).toHaveBeenCalledOnce();
  });
});
