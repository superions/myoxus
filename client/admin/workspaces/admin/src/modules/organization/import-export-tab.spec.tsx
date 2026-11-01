/**
 * @vitest-environment happy-dom
 */
/**
 * Import/export tab — ORG-F-T04: dry-run surfaces structured errors
 * without persisting (apply mutation is NOT triggered).
 */
import { notify } from "@myoxus/ui-facade";
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import enJson from "../../../../../../libs/i18n/src/resources/en.json";
const en: Record<string, string> = enJson;

vi.mock("@myoxus/i18n", () => ({
  I18n: new Proxy(
    {},
    { get: (_target, key) => () => en[String(key)] ?? String(key) },
  ),
  useI18n: () => ({
    t: (key: string, options?: Record<string, unknown>): string => {
      let text = en[key] ?? key;
      if (options) {
        Object.entries(options).forEach(([k, v]) => {
          text = text.replace(new RegExp(`\\{\\{${k}\\}\\}`, "g"), String(v));
        });
      }
      return text;
    },
  }),
}));

const structuredDryRunError = {
  admin: {
    organizationImportDryRun: {
      errors: [
        {
          source: "units",
          row: 2,
          field: "parentSlug",
          message: "parent cycle detected via 'alpha'",
        },
      ],
    },
  },
};
const dryRunTrigger = vi.fn();
const applyTrigger = vi.fn();
const refetchExport = vi.fn();
let exportError: Error | undefined;
let exportLoading = false;
let exportPayload:
  | {
      schemaVersion: number;
      json: string;
      files: { name: string; content: string }[];
    }
  | undefined;

vi.mock("./api", () => {
  return {
    useOrganizationExportQuery: () => ({
      isLoading: exportLoading,
      isValidating: false,
      error: exportError,
      mutate: refetchExport,
      exportPayload,
    }),
    useOrganizationImportDryRunMutation: () => ({
      trigger: dryRunTrigger,
      isMutating: false,
    }),
    useOrganizationImportApplyMutation: () => ({
      trigger: applyTrigger,
      isMutating: false,
    }),
  };
});

import { ImportExportTab } from "./import-export-tab";

function renderWithProvider(node: ReactElement) {
  return render(<MyoxusUIProvider>{node}</MyoxusUIProvider>);
}

function enterSnapshot() {
  fireEvent.click(
    screen.getByText(en["admin.organization.import.dropzone.paste"]),
  );
  fireEvent.change(screen.getByTestId("organization-import-textarea"), {
    target: { value: '{"schemaVersion":1}' },
  });
}

afterEach(() => {
  cleanup();
  notify.dismiss();
});

beforeEach(() => {
  vi.clearAllMocks();
  exportPayload = undefined;
  exportError = undefined;
  exportLoading = false;
  refetchExport.mockReset().mockResolvedValue(undefined);
  dryRunTrigger.mockResolvedValue(structuredDryRunError);
  applyTrigger.mockResolvedValue({
    admin: { organizationImportApply: { errors: [] } },
  });
});

describe("ImportExportTab", () => {
  test("dry-run shows structured error without calling apply (ORG-F-T04)", async () => {
    const { container } = renderWithProvider(<ImportExportTab />);
    expect(
      container.querySelector(".org-h3, .org-body, .org-label"),
    ).toBeNull();
    expect(screen.getByRole("heading", { name: "Export" }).tagName).toBe("H2");
    expect(screen.getByRole("heading", { name: "Import" }).tagName).toBe("H2");

    // Open the textarea via the localized manual-paste action.
    enterSnapshot();

    // Click dry-run
    const dryRunBtn = screen.getByTestId("organization-import-dry-run");
    fireEvent.click(dryRunBtn);

    await screen.findByText(/parent cycle detected/i);

    // Dry-run was triggered, apply was NOT
    expect(dryRunTrigger).toHaveBeenCalled();
    expect(applyTrigger).not.toHaveBeenCalled();

    // Error log surfaces the message
    expect(screen.getByRole("table", { name: "Import" }).textContent).toContain(
      "parentSlug",
    );
    expect(
      (screen.getByTestId("organization-import-apply") as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  test("does not report a missing dry-run payload as clean", async () => {
    dryRunTrigger.mockResolvedValueOnce(undefined);
    renderWithProvider(<ImportExportTab />);
    enterSnapshot();

    fireEvent.click(screen.getByTestId("organization-import-dry-run"));

    expect(
      await screen.findByText(en["admin.organization.import.request-failed"]),
    ).not.toBeNull();
    expect(
      screen.getByText(en["admin.organization.import.response-missing"]),
    ).not.toBeNull();
    expect(
      screen.queryByText(en["admin.organization.import.dry-run-clean-summary"]),
    ).toBeNull();
  });

  test("renders apply rejection and never claims completion", async () => {
    applyTrigger.mockResolvedValueOnce({
      admin: {
        organizationImportApply: {
          errors: [
            {
              source: "members",
              row: null,
              field: "source",
              message: "membership source conflict",
            },
          ],
        },
      },
    });
    renderWithProvider(<ImportExportTab />);
    enterSnapshot();
    dryRunTrigger.mockResolvedValueOnce({
      admin: { organizationImportDryRun: { errors: [] } },
    });
    fireEvent.click(screen.getByTestId("organization-import-dry-run"));
    await waitFor(() =>
      expect(
        (screen.getByTestId("organization-import-apply") as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );

    fireEvent.click(screen.getByTestId("organization-import-apply"));

    expect(
      (await screen.findByText("membership source conflict")).tagName,
    ).toBe("TD");
    expect(
      screen.queryByText(en["admin.organization.import.applied"]),
    ).toBeNull();
  });

  test("does not report a missing apply payload as completed", async () => {
    applyTrigger.mockResolvedValueOnce(undefined);
    renderWithProvider(<ImportExportTab />);
    enterSnapshot();
    dryRunTrigger.mockResolvedValueOnce({
      admin: { organizationImportDryRun: { errors: [] } },
    });
    fireEvent.click(screen.getByTestId("organization-import-dry-run"));
    await waitFor(() =>
      expect(
        (screen.getByTestId("organization-import-apply") as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );

    fireEvent.click(screen.getByTestId("organization-import-apply"));

    expect(
      await screen.findByText(en["admin.organization.import.request-failed"]),
    ).not.toBeNull();
    expect(
      screen.getByText(en["admin.organization.import.response-missing"]),
    ).not.toBeNull();
    expect(
      screen.queryByText(en["admin.organization.import.applied"]),
    ).toBeNull();
  });

  test("requires a clean preflight of the exact snapshot and invalidates it on edits", async () => {
    dryRunTrigger.mockResolvedValue({
      admin: { organizationImportDryRun: { errors: [] } },
    });
    renderWithProvider(<ImportExportTab />);
    enterSnapshot();
    const applyButton = screen.getByTestId(
      "organization-import-apply",
    ) as HTMLButtonElement;
    expect(applyButton.disabled).toBe(true);
    fireEvent.click(applyButton);
    expect(applyTrigger).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("organization-import-dry-run"));
    await waitFor(() => expect(applyButton.disabled).toBe(false));
    expect(
      screen.getByText(en["admin.organization.import.dry-run-clean-summary"]),
    ).not.toBeNull();
    fireEvent.change(screen.getByTestId("organization-import-textarea"), {
      target: { value: '{"schemaVersion":2}' },
    });
    expect(applyButton.disabled).toBe(true);
    expect(
      screen.queryByText(en["admin.organization.import.dry-run-clean-summary"]),
    ).toBeNull();
    fireEvent.click(screen.getByTestId("organization-import-dry-run"));
    await waitFor(() => expect(applyButton.disabled).toBe(false));
    fireEvent.click(applyButton);
    await waitFor(() =>
      expect(
        screen.getByTestId("organization-import-report").textContent,
      ).toContain(en["admin.organization.import.applied"]),
    );
    expect(applyTrigger).toHaveBeenCalledWith({
      input: { json: '{"schemaVersion":2}', files: null },
    });
  });

  test("prevents overlapping requests and preserves text after a request failure", async () => {
    let rejectRequest!: (error: Error) => void;
    dryRunTrigger.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectRequest = reject;
        }),
    );
    renderWithProvider(<ImportExportTab />);
    enterSnapshot();
    fireEvent.click(screen.getByTestId("organization-import-dry-run"));
    expect(
      (
        screen.getByTestId(
          "organization-import-textarea",
        ) as HTMLTextAreaElement
      ).disabled,
    ).toBe(true);
    expect(
      (screen.getByTestId("organization-import-apply") as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.click(screen.getByTestId("organization-import-dry-run"));
    expect(dryRunTrigger).toHaveBeenCalledTimes(1);
    rejectRequest(new Error("Import unavailable"));
    await screen.findByText("Import unavailable");
    expect(
      (
        screen.getByTestId(
          "organization-import-textarea",
        ) as HTMLTextAreaElement
      ).value,
    ).toBe('{"schemaVersion":1}');
    expect(
      (
        screen.getByTestId(
          "organization-import-textarea",
        ) as HTMLTextAreaElement
      ).disabled,
    ).toBe(false);
    expect(applyTrigger).not.toHaveBeenCalled();
  });

  test("export refresh failure does not relabel an acknowledged import or repeat its write", async () => {
    refetchExport.mockRejectedValue(new Error("Export readback failed"));
    dryRunTrigger.mockResolvedValue({
      admin: { organizationImportDryRun: { errors: [] } },
    });
    renderWithProvider(<ImportExportTab />);
    enterSnapshot();
    fireEvent.click(screen.getByTestId("organization-import-dry-run"));
    await waitFor(() =>
      expect(
        (screen.getByTestId("organization-import-apply") as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByTestId("organization-import-apply"));
    await screen.findByText("Export readback failed");
    expect(
      screen.getByTestId("organization-import-report").textContent,
    ).toContain(en["admin.organization.import.applied"]);
    expect(
      screen.queryByText(en["admin.organization.import.request-failed"]),
    ).toBeNull();
    expect(
      (screen.getByTestId("organization-import-apply") as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    refetchExport.mockResolvedValue(undefined);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(screen.queryByText("Export readback failed")).toBeNull(),
    );
    expect(applyTrigger).toHaveBeenCalledTimes(1);
    expect(refetchExport).toHaveBeenCalledTimes(2);
  });

  test("a file read failure after reset cannot restore the old preflight", async () => {
    dryRunTrigger.mockResolvedValue({
      admin: { organizationImportDryRun: { errors: [] } },
    });
    renderWithProvider(<ImportExportTab />);
    const file = new File(["{}"], "snapshot.json", {
      type: "application/json",
    });
    const input = document.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });
    await screen.findByTestId("organization-import-textarea");
    fireEvent.click(screen.getByTestId("organization-import-dry-run"));
    await waitFor(() =>
      expect(
        (screen.getByTestId("organization-import-apply") as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    const unreadable = new File(["{}"], "replacement.json", {
      type: "application/json",
    });
    vi.spyOn(unreadable, "text").mockRejectedValue(
      new Error("File unreadable"),
    );
    fireEvent.change(
      document.querySelector('input[type="file"]') as HTMLInputElement,
      { target: { files: [unreadable] } },
    );
    await screen.findByText("File unreadable");
    expect(
      screen.queryByText(en["admin.organization.import.dry-run-clean-summary"]),
    ).toBeNull();
    expect(applyTrigger).not.toHaveBeenCalled();
  });
});
