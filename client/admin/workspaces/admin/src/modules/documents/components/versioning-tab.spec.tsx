import type { ReactElement } from "react";
/** @vitest-environment happy-dom */
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Activity } from "react";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import enJson from "../../../../../../../libs/i18n/src/resources/en.json";

const en: Record<string, string> = enJson;
vi.mock("@myoxus/i18n", () => ({
  useI18n: () => ({
    "com.myoxus.peek-view-controls.close": () =>
      en["com.myoxus.peek-view-controls.close"],
    t: (key: string) => en[key] ?? key,
    exists: (key: string) => key in en,
    language: "en",
    changeLanguage: () => Promise.resolve(),
  }),
}));

const upsertPolicyMock = vi.fn();
const mutateMock = vi.fn();
let globalPolicyName = "Global policy";

vi.mock("../api", () => ({
  useDocumentVersionPoliciesQuery: () => ({
    policies: [
      {
        id: "policy-1",
        scope: "global",
        workspaceId: null,
        name: globalPolicyName,
        metadataSchema: { required: ["reference"] },
        isDefault: true,
        enabledByDefault: true,
        schemePreset: "simple_counter",
        customPattern: null,
        timezoneMode: "utc",
        autoVersionOn: ["on_pdf_export"],
        retentionCount: 12,
        pinManualVersions: false,
        pinPublishVersions: true,
        publishedVersionsProtected: true,
        exportVersionsProtected: true,
      },
      {
        id: "policy-2",
        scope: "workspace",
        workspaceId: "workspace-1",
        name: "Workspace policy",
        isDefault: false,
        enabledByDefault: false,
        schemePreset: "date_counter",
        customPattern: null,
        timezoneMode: "workspace",
        autoVersionOn: [],
        retentionCount: 3,
        pinManualVersions: true,
        pinPublishVersions: false,
        publishedVersionsProtected: false,
        exportVersionsProtected: false,
      },
    ],
    mutate: mutateMock,
  }),
  useUpsertDocumentVersionPolicyMutation: () => ({
    upsertPolicy: upsertPolicyMock,
    isMutating: false,
    error: undefined,
  }),
}));

import { VersioningTab } from "./versioning-tab";

function renderWithProvider(node: ReactElement) {
  return render(<MyoxusUIProvider>{node}</MyoxusUIProvider>);
}

describe("VersioningTab", () => {
  beforeEach(() => {
    globalPolicyName = "Global policy";
    mutateMock.mockReset().mockResolvedValue(undefined);
    upsertPolicyMock.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => cleanup());

  test("renders policies as soft-list and keeps policy editor bound", async () => {
    renderWithProvider(<VersioningTab />);

    expect(
      screen
        .getByRole("button", { name: "Global policy" })
        .getAttribute("aria-pressed"),
    ).toBe("true");

    fireEvent.change(screen.getByLabelText("Retention count"), {
      target: { value: "24" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(upsertPolicyMock).toHaveBeenCalledTimes(1));
    expect(upsertPolicyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "policy-1",
        retentionCount: 24,
        scope: "global",
        schemePreset: "simple_counter",
        metadataSchema: { required: ["reference"] },
      }),
    );
  });

  test("selects a policy by keyboard and resets its draft without saving", async () => {
    const user = userEvent.setup();
    renderWithProvider(<VersioningTab />);
    const global = screen.getByRole("button", { name: "Global policy" });
    const workspace = screen.getByRole("button", { name: "Workspace policy" });
    expect(global.getAttribute("aria-pressed")).toBe("true");
    workspace.focus();
    await user.keyboard("{Enter}");
    expect(workspace.getAttribute("aria-pressed")).toBe("true");
    expect(global.getAttribute("aria-pressed")).toBe("false");
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe(
      "Workspace policy",
    );
    expect(
      (screen.getByLabelText("Retention count") as HTMLInputElement).value,
    ).toBe("3");
    fireEvent.change(screen.getByLabelText("Retention count"), {
      target: { value: "8" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(
      (screen.getByLabelText("Retention count") as HTMLInputElement).value,
    ).toBe("3");
    expect(upsertPolicyMock).not.toHaveBeenCalled();
  });

  test("guards dirty policy changes and preserves drafts across refreshed retained tabs", async () => {
    const view = (mode: "visible" | "hidden" = "visible") => (
      <MyoxusUIProvider>
        <Activity mode={mode}>
          <VersioningTab />
        </Activity>
      </MyoxusUIProvider>
    );
    const { rerender } = render(view());
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Unsaved policy" },
    });
    globalPolicyName = "Refreshed global policy";
    rerender(view("hidden"));
    rerender(view());
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe(
      "Unsaved policy",
    );
    fireEvent.click(screen.getByRole("button", { name: "Workspace policy" }));
    expect((await screen.findByRole("dialog")).textContent).toContain(
      en["admin.unsaved.discard-title"],
    );
    fireEvent.click(screen.getByTestId("admin-confirm-modal-cancel"));
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe(
      "Unsaved policy",
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Workspace policy" }));
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByTestId("admin-confirm-modal-confirm"));
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe(
      "Workspace policy",
    );
    expect(upsertPolicyMock).not.toHaveBeenCalled();
  });

  test("retains invalid retention input, disables saving but still allows reset", () => {
    renderWithProvider(<VersioningTab />);
    fireEvent.change(screen.getByLabelText("Retention count"), {
      target: { value: "0" },
    });
    expect(
      (screen.getByRole("button", { name: "Save" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Reset" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(
      (screen.getByLabelText("Retention count") as HTMLInputElement).value,
    ).toBe("12");
    expect(upsertPolicyMock).not.toHaveBeenCalled();
  });

  test("keeps the selected policy and draft after rejected saving", async () => {
    upsertPolicyMock.mockRejectedValueOnce(new Error("Policy write rejected"));
    renderWithProvider(<VersioningTab />);
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Policy draft" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(
      (await screen.findByText("Policy write rejected")).getAttribute("role"),
    ).toBe("alert");
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe(
      "Policy draft",
    );
    expect(
      screen
        .getByRole("button", { name: "Global policy" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });
});
