/**
 * @vitest-environment happy-dom
 */
import {
  GitSyncAuthMethod,
  GitSyncCronMisfirePolicy,
  GitSyncDirection,
  GitSyncTriggerMode,
} from "@myoxus/graphql";
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import { notify } from "@myoxus/ui-facade";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { Activity, type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import enJson from "../../../../../../libs/i18n/src/resources/en.json";

const en: Record<string, string> = enJson;
const mutationTriggers: Record<string, ReturnType<typeof vi.fn>> = {};
const profileMutate = vi.fn().mockResolvedValue(undefined);
const statusMutate = vi.fn().mockResolvedValue(undefined);
const rotationMutate = vi.fn().mockResolvedValue(undefined);
let profile: Record<string, unknown> | null;
let rotationStatus: Record<string, unknown> | null;
let previewError: false | "cronExpression" | "cronTimezone" = false;

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

vi.mock("../../use-query", () => ({
  useQuery: (options?: {
    query?: { id: string };
    variables?: { cron?: string };
  }) => {
    switch (options?.query?.id) {
      case "getGitSyncProfileQuery":
        return {
          data: { workspace: { gitSyncProfile: profile } },
          isLoading: false,
          mutate: profileMutate,
        };
      case "getGitSyncStatusQuery":
        return {
          data: {
            workspace: {
              gitSyncStatus: {
                lastRun: {
                  triggerSource: "Cron",
                  scheduledFor: "2026-10-25T00:30:00Z",
                  startedAt: "2026-10-25T00:30:02Z",
                },
              },
            },
          },
          isLoading: false,
          mutate: statusMutate,
        };
      case "getGitSyncPoliciesQuery":
        return {
          data: {
            serverConfig: {
              gitSync: {
                defaultBranch: "main",
              },
            },
          },
          isLoading: false,
        };
      case "gitSyncTimezonesQuery":
        return {
          data: { gitSyncTimezones: ["Europe/Berlin", "UTC"] },
          isLoading: false,
        };
      case "gitSyncSchedulePreviewQuery":
        return previewError || options.variables?.cron === "invalid"
          ? {
              data: undefined,
              error: Object.assign(new Error("invalid server schedule"), {
                extensions: {
                  field: previewError || "cronExpression",
                },
              }),
              isLoading: false,
            }
          : {
              data: {
                gitSyncSchedulePreview: Array.from(
                  { length: 5 },
                  (_, index) => ({
                    scheduledAtUtc: `2026-10-25T0${index}:30:00Z`,
                    localDateTime: `2026-10-25T0${index + 2}:30:00`,
                    utcOffsetSeconds: 7200,
                  }),
                ),
              },
              isLoading: false,
            };
      case "adminGitTokenRotationQuery":
        return {
          data: {
            admin: {
              gitTokenRotationProviders: ["GitLab"],
              gitTokenRotationStatus: rotationStatus,
            },
          },
          isLoading: false,
          mutate: rotationMutate,
        };
      default:
        return { data: undefined, isLoading: false, mutate: vi.fn() };
    }
  },
}));

vi.mock("../../use-mutation", () => ({
  useMutation: ({ mutation }: { mutation: { id: string } }) => {
    mutationTriggers[mutation.id] ??= vi
      .fn()
      .mockResolvedValue(
        mutation.id === "testGitConnectionMutation"
          ? { testGitConnection: true }
          : {},
      );
    return { trigger: mutationTriggers[mutation.id], isMutating: false };
  },
}));

import { GitSyncProfileEditor } from "./profile-editor";

function renderWithProvider(node: ReactElement) {
  return render(<MyoxusUIProvider>{node}</MyoxusUIProvider>);
}

async function selectFacadeOption(
  label: string | RegExp,
  option: string | RegExp,
) {
  fireEvent.click(screen.getByRole("combobox", { name: label }));
  fireEvent.click(await screen.findByRole("option", { name: option }));
}

function cronProfile(overrides: Record<string, unknown> = {}) {
  return {
    id: "profile-1",
    repoUrl: "https://git.example.test/team/workspace.git",
    branch: "main",
    rootPath: "content/",
    syncDirection: GitSyncDirection.Bidirectional,
    triggerMode: GitSyncTriggerMode.Cron,
    pollingIntervalSecs: null,
    cronExpression: "0 * * * *",
    cronTimezone: "Europe/Berlin",
    cronMisfirePolicy: GitSyncCronMisfirePolicy.RunOnce,
    cronNextScheduledAt: "2026-10-25T00:30:00Z",
    cronPendingMisfireScheduledFor: "2026-10-25T01:30:00Z",
    authMethod: GitSyncAuthMethod.HttpsToken,
    enabled: true,
    updatedAt: "2026-10-24T10:00:00Z",
    ...overrides,
  };
}

describe("GitSyncProfileEditor Cron workflow", () => {
  beforeEach(() => {
    notify.dismiss();
    profile = null;
    rotationStatus = null;
    previewError = false;
    profileMutate.mockClear();
    statusMutate.mockClear();
    rotationMutate.mockClear();
    for (const id of Object.keys(mutationTriggers)) delete mutationTriggers[id];
  });

  afterEach(() => cleanup());

  test("keeps profile fields and dirty ownership after a failed save and Activity reactivation", async () => {
    profile = cronProfile();
    const dirty = vi.fn();
    const changed = vi.fn();
    const view = (mode: "visible" | "hidden") => (
      <MyoxusUIProvider>
        <Activity mode={mode}>
          <GitSyncProfileEditor
            workspaceId="workspace-1"
            onChanged={changed}
            onDirtyChange={dirty}
          />
        </Activity>
      </MyoxusUIProvider>
    );
    const result = render(view("visible"));
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Branch"), {
      target: { value: "operator-draft" },
    });
    mutationTriggers.updateGitSyncProfileMutation.mockRejectedValueOnce(
      new Error("write rejected"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("write rejected");
    expect(changed).not.toHaveBeenCalled();
    expect(dirty).toHaveBeenLastCalledWith(true);
    result.rerender(view("hidden"));
    result.rerender(view("visible"));
    expect((screen.getByLabelText("Branch") as HTMLInputElement).value).toBe(
      "operator-draft",
    );
    expect(dirty).toHaveBeenLastCalledWith(true);
  });

  test("renders canonical Cron recovery state and triggers a manual test run without changing the schedule", async () => {
    profile = cronProfile();
    renderWithProvider(
      <GitSyncProfileEditor workspaceId="workspace-1" onChanged={vi.fn()} />,
    );

    expect(screen.getByText("0 * * * *")).toBeTruthy();
    expect(screen.getByText("Europe/Berlin")).toBeTruthy();
    expect(
      screen.getByText("Run the most recent missed occurrence once"),
    ).toBeTruthy();
    expect(screen.getByText("Pending catch-up")).toBeTruthy();
    expect(screen.getAllByText(/Cron/).length).toBeGreaterThanOrEqual(1);

    fireEvent.click(screen.getByRole("button", { name: "Run test sync" }));
    await waitFor(() =>
      expect(mutationTriggers.triggerGitSyncMutation).toHaveBeenCalledWith({
        workspaceId: "workspace-1",
      }),
    );
    expect(mutationTriggers.updateGitSyncProfileMutation).toBeUndefined();
  });

  test("creates a Cron profile only after a five-occurrence server preview", async () => {
    const onChanged = vi.fn().mockResolvedValue(undefined);
    renderWithProvider(
      <GitSyncProfileEditor workspaceId="workspace-1" onChanged={onChanged} />,
    );

    fireEvent.change(screen.getByLabelText("Repository URL"), {
      target: { value: "https://git.example.test/team/workspace.git" },
    });
    fireEvent.change(screen.getByLabelText("Token / Key"), {
      target: { value: "secret-token" },
    });
    await selectFacadeOption("Trigger Mode", "Cron");

    expect(
      screen.getByTestId("git-sync-cron-preview").querySelectorAll("dt"),
    ).toHaveLength(5);
    fireEvent.click(screen.getByRole("button", { name: "Create Profile" }));

    await waitFor(() =>
      expect(
        mutationTriggers.createGitSyncProfileMutation,
      ).toHaveBeenCalledOnce(),
    );
    expect(
      mutationTriggers.createGitSyncProfileMutation.mock.calls[0][0],
    ).toMatchObject({
      workspaceId: "workspace-1",
      input: {
        triggerMode: GitSyncTriggerMode.Cron,
        cronExpression: "0 * * * *",
        cronTimezone: "UTC",
        cronMisfirePolicy: GitSyncCronMisfirePolicy.Skip,
        pollingIntervalSecs: null,
        token: "secret-token",
      },
    });
    expect(onChanged).toHaveBeenCalledOnce();
  });

  test("edits schedule fields through patch semantics without submitting credentials", async () => {
    profile = cronProfile();
    renderWithProvider(
      <GitSyncProfileEditor workspaceId="workspace-1" onChanged={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Cron expression"), {
      target: { value: "15 * * * *" },
    });
    await selectFacadeOption("Missed-run policy", "Skip missed occurrences");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(
        mutationTriggers.updateGitSyncProfileMutation,
      ).toHaveBeenCalledOnce(),
    );
    const variables =
      mutationTriggers.updateGitSyncProfileMutation.mock.calls[0][0];
    expect(variables).toMatchObject({
      profileId: "profile-1",
      input: {
        triggerMode: GitSyncTriggerMode.Cron,
        cronExpression: "15 * * * *",
        cronTimezone: "Europe/Berlin",
        cronMisfirePolicy: GitSyncCronMisfirePolicy.Skip,
      },
    });
    expect(variables.input).not.toHaveProperty("credential");
    expect(variables.input).not.toHaveProperty("token");
  });

  test("switches an existing profile to saved-version sync without credentials", async () => {
    profile = cronProfile({
      repoUrl: "ssh://git@git.internal/repos/workspace.git",
      authMethod: GitSyncAuthMethod.SshKey,
    });
    renderWithProvider(
      <GitSyncProfileEditor workspaceId="workspace-1" onChanged={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    await selectFacadeOption("Trigger Mode", "On new version");
    expect(
      screen.getByText(/Each saved version starts an outgoing sync/),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(
        mutationTriggers.updateGitSyncProfileMutation,
      ).toHaveBeenCalledOnce(),
    );
    const variables =
      mutationTriggers.updateGitSyncProfileMutation.mock.calls[0][0];
    expect(variables).toMatchObject({
      profileId: "profile-1",
      input: {
        repoUrl: "ssh://git@git.internal/repos/workspace.git",
        triggerMode: GitSyncTriggerMode.HistoryCapture,
        pollingIntervalSecs: null,
        cronExpression: null,
        cronTimezone: null,
        cronMisfirePolicy: null,
      },
    });
    expect(variables.input).not.toHaveProperty("token");
    expect(variables.input).not.toHaveProperty("credential");
  });

  test("keeps Save disabled when the server rejects the schedule", () => {
    profile = cronProfile();
    previewError = "cronExpression";
    renderWithProvider(
      <GitSyncProfileEditor workspaceId="workspace-1" onChanged={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    expect(
      screen.getByRole("button", { name: "Save" }).hasAttribute("disabled"),
    ).toBe(true);
    expect(screen.getAllByText("invalid server schedule")).toHaveLength(1);
  });

  test("maps the server timezone extension to the searchable timezone field", () => {
    profile = cronProfile();
    previewError = "cronTimezone";
    renderWithProvider(
      <GitSyncProfileEditor workspaceId="workspace-1" onChanged={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    expect(
      screen
        .getByRole("combobox", { name: "Timezone" })
        .getAttribute("aria-invalid"),
    ).toBe("true");
    expect(
      screen.getByRole("button", { name: "Save" }).hasAttribute("disabled"),
    ).toBe(true);
    expect(screen.getAllByText("invalid server schedule")).toHaveLength(1);
  });

  test("uses the server polling boundary instead of imposing a client-only minimum", async () => {
    renderWithProvider(
      <GitSyncProfileEditor workspaceId="workspace-1" onChanged={vi.fn()} />,
    );

    await selectFacadeOption("Trigger Mode", "Polling");

    fireEvent.change(screen.getByLabelText("Polling"), {
      target: { value: "1" },
    });
    fireEvent.change(screen.getByLabelText("Repository URL"), {
      target: { value: "https://git.example.test/team/workspace.git" },
    });
    fireEvent.change(screen.getByLabelText("Token / Key"), {
      target: { value: "test-only-token" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create Profile" }));
    await waitFor(() =>
      expect(
        mutationTriggers.createGitSyncProfileMutation,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          input: expect.objectContaining({ pollingIntervalSecs: 1 }),
        }),
      ),
    );
  });

  test("consumes server-owned token rotation states without permission controls", () => {
    profile = cronProfile();
    const states = [
      ["Configured", "Configured"],
      ["Failed", "Failed before request"],
      ["ManualIntervention", "Manual intervention"],
      ["Completed", "Completed"],
    ] as const;

    for (const [state, label] of states) {
      rotationStatus = {
        profileId: "profile-1",
        provider: "GitLab",
        enabled: true,
        state,
        renewBeforeDays: 30,
        requestedLifetimeDays: 90,
        currentCredentialExpiresAt: "2026-11-29T10:00:00Z",
        nextAttemptAt: "2026-10-30T10:00:00Z",
        lastAttemptAt: state === "Configured" ? null : "2026-08-31T10:00:00Z",
        lastSuccessAt: state === "Completed" ? "2026-08-31T10:00:01Z" : null,
        diagnosis: state === "Failed" ? "request was not transmitted" : null,
      };
      renderWithProvider(
        <GitSyncProfileEditor workspaceId="workspace-1" onChanged={vi.fn()} />,
      );
      expect(screen.getByText("Project token rotation")).toBeTruthy();
      expect(screen.getByText(label)).toBeTruthy();
      const nextAttempt = new Intl.DateTimeFormat("en", {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date("2026-10-30T10:00:00Z"));
      expect(screen.getByText(nextAttempt).textContent).toBe(nextAttempt);
      expect(screen.queryByText("Scopes")).toBeNull();
      expect(screen.queryByText("Access level")).toBeNull();
      expect(screen.queryByText("Remote token ID")).toBeNull();
      cleanup();
    }
  });

  test("configures and runs token rotation through generated AdminRoot operations", async () => {
    profile = cronProfile();
    rotationStatus = {
      profileId: "profile-1",
      provider: "GitLab",
      enabled: true,
      state: "Completed",
      renewBeforeDays: 30,
      requestedLifetimeDays: 90,
      currentCredentialExpiresAt: "2026-11-29T10:00:00Z",
      nextAttemptAt: "2026-10-30T10:00:00Z",
      lastAttemptAt: "2026-08-31T10:00:00Z",
      lastSuccessAt: "2026-08-31T10:00:01Z",
      diagnosis: null,
    };
    renderWithProvider(
      <GitSyncProfileEditor workspaceId="workspace-1" onChanged={vi.fn()} />,
    );

    fireEvent.change(screen.getByLabelText("Renew before expiry (days)"), {
      target: { value: "20" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(
        mutationTriggers.configureGitTokenRotationMutation,
      ).toHaveBeenCalledWith({
        input: {
          profileId: "profile-1",
          provider: "GitLab",
          enabled: true,
          renewBeforeDays: 20,
          requestedLifetimeDays: 90,
        },
      }),
    );
    expect(rotationMutate).toHaveBeenCalledOnce();
    expect(
      await screen.findByText("Token rotation settings saved"),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Rotate now" }));
    await waitFor(() =>
      expect(
        mutationTriggers.runGitTokenRotationNowMutation,
      ).toHaveBeenCalledWith({ profileId: "profile-1" }),
    );
    expect(rotationMutate).toHaveBeenCalledTimes(2);
  });
});
