/**
 * @vitest-environment happy-dom
 */
import { GitSyncTriggerMode } from "@myoxus/graphql";
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import enJson from "../../../../../../../../../i18n/src/resources/en.json";

const en: Record<string, string> = enJson;
const mutationTriggers: Record<string, ReturnType<typeof vi.fn>> = {};
const profileMutate = vi.fn().mockResolvedValue(undefined);
const statusMutate = vi.fn().mockResolvedValue(undefined);
let configuredTrigger = GitSyncTriggerMode.Cron;

vi.mock("@myoxus/i18n", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useI18n: () =>
    new Proxy(
      { language: "en" },
      {
        get(target, property) {
          if (property === "language") return target.language;
          return (options?: Record<string, unknown>) => {
            let text = en[String(property)] ?? String(property);
            for (const [name, value] of Object.entries(options ?? {})) {
              text = text.replace(
                new RegExp(`\\{\\{${name}\\}\\}`, "g"),
                String(value),
              );
            }
            return text;
          };
        },
      },
    ),
}));

vi.mock("@myoxus/infra", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useService: () => ({ workspace: { id: "workspace-1" } }),
}));

vi.mock("@myoxus/core/components/hooks/use-query", () => ({
  useQuery: ({ query }: { query: { id: string } }) => {
    switch (query.id) {
      case "getGitSyncPoliciesQuery":
        return {
          data: {
            serverConfig: {
              gitSync: {
                enabled: true,
                autoSyncAllowed: true,
                webhookAllowed: true,
              },
            },
          },
          mutate: vi.fn(),
        };
      case "getGitSyncProfileQuery":
        return {
          data: {
            workspace: {
              gitSyncProfile: {
                id: "profile-1",
                repoUrl: "https://git.example.test/team/workspace.git",
                branch: "main",
                rootPath: "content/",
                syncDirection: "Bidirectional",
                triggerMode: configuredTrigger,
                pollingIntervalSecs: null,
                cronExpression: "0 * * * *",
                cronTimezone: "Europe/Berlin",
                cronMisfirePolicy: "RunOnce",
                cronNextScheduledAt: "2026-10-25T00:30:00Z",
                cronPendingMisfireScheduledFor: "2026-10-25T01:30:00Z",
                authMethod: "HttpsToken",
                enabled: true,
                createdAt: "2026-01-01T00:00:00Z",
                updatedAt: "2026-01-01T00:00:00Z",
              },
            },
          },
          mutate: profileMutate,
        };
      case "getGitSyncStatusQuery":
        return {
          data: {
            workspace: {
              gitSyncStatus: {
                lastRun: {
                  id: "run-1",
                  status: "Completed",
                  startedAt: "2026-10-25T00:30:02Z",
                  errorMessage: null,
                },
                openConflicts: 0,
                totalBindings: 0,
              },
            },
          },
          mutate: statusMutate,
        };
      case "getGitSyncRunsQuery":
        return { data: { workspace: { gitSyncRuns: [] } }, mutate: vi.fn() };
      case "getGitSyncConflictsQuery":
        return {
          data: { workspace: { gitSyncConflicts: [] } },
          mutate: vi.fn(),
        };
      case "getGitSyncBindingsQuery":
        return {
          data: { workspace: { gitSyncBindings: [] } },
          mutate: vi.fn(),
        };
      default:
        return { data: undefined, mutate: vi.fn() };
    }
  },
}));

vi.mock("@myoxus/core/components/hooks/use-mutation", () => ({
  useMutation: ({ mutation }: { mutation: { id: string } }) => {
    mutationTriggers[mutation.id] ??= vi.fn().mockResolvedValue({});
    return { trigger: mutationTriggers[mutation.id], isMutating: false };
  },
}));

import { GitSyncSettingPanel } from "../setting-panel";

describe("Core Git Sync Cron compatibility", () => {
  beforeEach(() => {
    configuredTrigger = GitSyncTriggerMode.Cron;
    for (const trigger of Object.values(mutationTriggers)) {
      trigger.mockReset().mockResolvedValue({});
    }
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  test("renders server-owned Cron state and manual sync cannot edit or delete the profile", async () => {
    render(
      <MyoxusUIProvider>
        <GitSyncSettingPanel />
      </MyoxusUIProvider>,
    );

    // Schedule values must be read-only facts, never editable profile controls.
    for (const value of [
      "0 * * * *",
      "Europe/Berlin",
      "Run the most recent missed occurrence once",
    ]) {
      expect(screen.getByText(value).closest("dd")?.textContent).toBe(value);
      expect(screen.queryByDisplayValue(value)).toBeNull();
    }
    expect(
      screen.getByText(
        "Cron schedules are managed in the Admin console. Manual sync remains available here.",
      ).textContent,
    ).toContain("Manual sync remains available here.");
    expect(screen.queryByRole("button", { name: "Delete Profile" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Sync Now" }));
    await waitFor(() =>
      expect(mutationTriggers.triggerGitSyncMutation).toHaveBeenCalledWith({
        workspaceId: "workspace-1",
      }),
    );
    expect(
      mutationTriggers.deleteGitSyncProfileMutation,
    ).not.toHaveBeenCalled();
    expect(mutationTriggers.updateGitSyncProfileMutation).toBeUndefined();
  });

  test("edits an existing trigger without credentials and retains a failed selection for retry", async () => {
    configuredTrigger = GitSyncTriggerMode.Manual;
    render(
      <MyoxusUIProvider>
        <GitSyncSettingPanel />
      </MyoxusUIProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit trigger" }));
    fireEvent.click(screen.getByRole("combobox"));
    fireEvent.click(
      await screen.findByRole("option", { name: "On new version" }),
    );
    mutationTriggers.updateGitSyncProfileMutation.mockRejectedValueOnce(
      new Error("save rejected"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save trigger" }));
    await waitFor(() =>
      expect(
        mutationTriggers.updateGitSyncProfileMutation,
      ).toHaveBeenCalledWith({
        profileId: "profile-1",
        input: {
          triggerMode: GitSyncTriggerMode.HistoryCapture,
          pollingIntervalSecs: null,
        },
      }),
    );
    expect(screen.getByRole("combobox").getAttribute("value")).toBe(
      "On new version",
    );

    fireEvent.click(screen.getByRole("button", { name: "Save trigger" }));
    await waitFor(() =>
      expect(
        mutationTriggers.updateGitSyncProfileMutation,
      ).toHaveBeenCalledTimes(2),
    );
    expect(profileMutate).toHaveBeenCalled();
    const input =
      mutationTriggers.updateGitSyncProfileMutation.mock.calls[1][0].input;
    expect(input).not.toHaveProperty("token");
    expect(input).not.toHaveProperty("repoUrl");
    expect(input).not.toHaveProperty("syncDirection");
  });
});
