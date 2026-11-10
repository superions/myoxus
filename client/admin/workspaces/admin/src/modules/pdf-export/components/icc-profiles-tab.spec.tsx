/**
 * @vitest-environment happy-dom
 *
 * Focused tests for the PDF Export ICC profile admin tab.
 */
import { PdfIccProfileTypeEnum } from "@myoxus/graphql";
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import enJson from "../../../../../../../libs/i18n/src/resources/en.json";

const en: Record<string, string> = enJson;
const tMock = vi.fn((key: string) => en[key] ?? key);
const mutateProfiles = vi.fn().mockResolvedValue(undefined);
const uploadTrigger = vi.fn().mockResolvedValue({});
const deleteTrigger = vi.fn().mockResolvedValue({});
const notifyMock = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
}));

const profiles = [
  {
    id: "system-srgb",
    name: "sRGB v4 (system)",
    profileType: PdfIccProfileTypeEnum.sRGB,
    sha256: "a".repeat(64),
    uploadedBy: null,
    uploadedAt: "2026-05-01T08:00:00Z",
  },
  {
    id: "system-swop",
    name: "Artifex CMYK SWOP (system)",
    profileType: PdfIccProfileTypeEnum.CMYK,
    sha256: "b".repeat(64),
    uploadedBy: null,
    uploadedAt: "2026-05-01T08:00:00Z",
  },
  {
    id: "system-ps-cmyk",
    name: "Artifex PostScript CMYK (system)",
    profileType: PdfIccProfileTypeEnum.CMYK,
    sha256: "c".repeat(64),
    uploadedBy: null,
    uploadedAt: "2026-05-01T08:00:00Z",
  },
  {
    id: "fogra39",
    name: "FOGRA39",
    profileType: PdfIccProfileTypeEnum.CMYK,
    sha256: "d".repeat(64),
    uploadedBy: "admin-user",
    uploadedAt: "2026-05-01T09:00:00Z",
  },
];

vi.mock("@myoxus/i18n", () => ({
  useI18n: () => ({
    "com.myoxus.peek-view-controls.close": () =>
      en["com.myoxus.peek-view-controls.close"],
    t: tMock,
    exists: (key: string) => key in en,
    language: "en",
    changeLanguage: () => Promise.resolve(),
  }),
}));

vi.mock("@myoxus/ui-facade", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, notify: notifyMock };
});

vi.mock("../api", () => ({
  usePdfIccProfilesQuery: () => ({ profiles, mutate: mutateProfiles }),
  useUploadIccProfileMutation: () => ({ trigger: uploadTrigger }),
  useDeleteIccProfileMutation: () => ({ trigger: deleteTrigger }),
}));

import { IccProfilesTab } from "./icc-profiles-tab";

function renderWithFacade(ui: ReactElement) {
  return render(<MyoxusUIProvider>{ui}</MyoxusUIProvider>);
}

describe("IccProfilesTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    uploadTrigger.mockResolvedValue({});
    deleteTrigger.mockResolvedValue({});
  });

  afterEach(() => {
    cleanup();
  });

  test("renders system and uploaded ICC profiles with protected system default", () => {
    renderWithFacade(<IccProfilesTab />);

    expect(screen.getByText("sRGB v4 (system)")).toBeTruthy();
    expect(screen.getByText("Artifex CMYK SWOP (system)")).toBeTruthy();
    expect(screen.getByText("Artifex PostScript CMYK (system)")).toBeTruthy();
    expect(screen.getAllByText("System seeded")).toHaveLength(3);
    expect(screen.getByText("FOGRA39")).toBeTruthy();
    expect(screen.getByText("admin-user")).toBeTruthy();
    expect(screen.getAllByLabelText("Delete")).toHaveLength(1);
  });

  test("maps server validation errors to operator-readable messages", async () => {
    uploadTrigger.mockRejectedValueOnce(
      new Error("Profile-Class is Display instead of Output"),
    );
    renderWithFacade(<IccProfilesTab />);

    fireEvent.click(screen.getByRole("button", { name: "Upload profile" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Upload ICC profile",
    });
    fireEvent.change(within(dialog).getByLabelText("Profile name"), {
      target: { value: "Display Profile" },
    });
    const iccFile = new File(["icc"], "display.icc", {
      type: "application/octet-stream",
    });
    fireEvent.drop(within(dialog).getByTestId("pdf-icc-upload-dropzone"), {
      dataTransfer: { files: [iccFile] },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Upload profile" }),
    );

    await waitFor(() => {
      expect(uploadTrigger).toHaveBeenCalledWith({
        name: "Display Profile",
        profileType: PdfIccProfileTypeEnum.sRGB,
        file: iccFile,
      });
      expect(within(dialog).getByRole("alert").textContent).toContain(
        "This is a Display profile. PDF export requires an Output profile for print-safe color conversion.",
      );
    });
  });

  test("deletes uploaded profiles only after confirmation", async () => {
    renderWithFacade(<IccProfilesTab />);

    fireEvent.click(screen.getByLabelText("Delete"));
    expect(deleteTrigger).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByTestId("admin-confirm-modal-confirm"));

    await waitFor(() => {
      expect(deleteTrigger).toHaveBeenCalledWith({ id: "fogra39" });
      expect(mutateProfiles).toHaveBeenCalled();
    });
  });
});
