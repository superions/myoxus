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

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import enJson from "../../../../../../../libs/i18n/src/resources/en.json";

const en: Record<string, string> = enJson;
const uploadLogo = vi.fn().mockResolvedValue({});
const deleteLogo = vi.fn().mockResolvedValue({});
const updateColors = vi.fn();
const setColorPolicy = vi.fn().mockResolvedValue({});
const updateText = vi.fn();
const resetBranding = vi.fn().mockResolvedValue({});
const mutateAsset = vi.fn();
const profiles: Record<string, any> = {};

function profile(workspaceId: string) {
  return {
    workspaceId,
    logoLargeBlob: null,
    logoSmallBlob: "small.svg",
    footerText: "Confidential",
    colorPolicy: "custom",
    colorPaletteKey: null,
    brandColorPrimary: "#112233",
    brandColorAccent: "#445566",
    brandColorRule: "#445566",
    brandColorText: "#111111",
    brandColorBackground: "#ffffff",
    updatedAt: "2026-05-01T10:00:00Z",
    updatedBy: "admin-1",
  };
}
const notifyMock = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
}));

vi.mock("@myoxus/i18n", () => ({
  useI18n: () => ({
    t: (key: string) => en[key] ?? key,
    language: "en",
    "com.myoxus.peek-view-controls.close": () =>
      en["com.myoxus.peek-view-controls.close"],
  }),
}));

vi.mock("@myoxus/ui-facade", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, notify: notifyMock };
});

vi.mock("../../../use-query", () => ({
  useQuery: () => ({
    data: {
      admin: {
        adminWorkspaces: [
          { id: "ws-1", name: "Workspace One" },
          { id: "ws-2", name: "Workspace Two" },
        ],
      },
    },
  }),
}));

vi.mock("../../settings/use-app-config", () => ({
  useAppConfig: () => ({
    appConfig: { pdf_export: { max_brand_asset_size_mb: 8 } },
  }),
}));

vi.mock("@myoxus/graphql", async () => {
  const actual = await vi.importActual<any>("@myoxus/graphql");
  return {
    ...actual,
    BrandLogoKind: { Large: "Large", Small: "Small" },
    adminWorkspacesQuery: { id: "adminWorkspacesQuery" },
  };
});

vi.mock("../api", () => ({
  useDocumentBrandingProfileQuery: (workspaceId: string) => ({
    profile: profiles[workspaceId],
    mutate: mutateAsset,
  }),
  useDocumentBrandColorPalettesQuery: () => ({
    palettes: [
      {
        themeSlug: "stuttgart",
        themeName: "Stuttgart",
        paletteKey: "balanced",
        name: "Balanced",
        primaryColor: "#102030",
        accentColor: "#405060",
        ruleColor: "#405060",
        textColor: "#111111",
        backgroundColor: "#ffffff",
        isDefault: true,
      },
    ],
  }),
  useResetWorkspaceDocumentBrandingMutation: () => ({
    resetWorkspaceDocumentBranding: resetBranding,
  }),
  useUploadDocumentBrandLogoMutation: () => ({
    uploadDocumentBrandLogo: uploadLogo,
  }),
  useDeleteDocumentBrandLogoMutation: () => ({
    deleteDocumentBrandLogo: deleteLogo,
  }),
  useUpdateDocumentBrandingTextMutation: () => ({
    updateDocumentBrandingText: updateText,
  }),
  useUpdateDocumentBrandingColorsMutation: () => ({
    updateDocumentBrandingColors: updateColors,
  }),
  useSetDocumentBrandingColorPolicyMutation: () => ({
    setDocumentBrandingColorPolicy: setColorPolicy,
  }),
}));

import { BrandAssetsTab } from "./brand-assets-tab";

function renderWithFacade(ui: ReactElement) {
  return render(<MyoxusUIProvider env="test">{ui}</MyoxusUIProvider>);
}

async function chooseWorkspace(name = "Workspace One") {
  fireEvent.click(screen.getByRole("combobox"));
  fireEvent.click(await screen.findByRole("option", { name }));
  fireEvent.blur(screen.getByRole("combobox"));
}

describe("BrandAssetsTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    profiles["ws-1"] = profile("ws-1");
    profiles["ws-2"] = profile("ws-2");
    mutateAsset.mockResolvedValue({});
    updateText.mockImplementation(async ({ workspaceId, footerText }) => {
      profiles[workspaceId].footerText = footerText;
      return { workspaceId, footerText };
    });
    updateColors.mockImplementation(
      async ({ workspaceId, primary, accent }) => {
        Object.assign(profiles[workspaceId], {
          colorPolicy: "custom",
          brandColorPrimary: primary,
          brandColorAccent: accent,
        });
        return profiles[workspaceId];
      },
    );
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn(() => "blob:preview"),
      revokeObjectURL: vi.fn(),
    });
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  test("uploads a logo with local thumbnail preview and server size hint", async () => {
    let finishUpload!: () => void;
    uploadLogo.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishUpload = () => resolve({});
        }),
    );
    renderWithFacade(<BrandAssetsTab />);
    await chooseWorkspace();

    expect(screen.getAllByText(/maximum 8 MiB/).length).toBeGreaterThan(0);
    const file = new File(["<svg />"], "logo.svg", { type: "image/svg+xml" });
    fireEvent.drop(screen.getByTestId("pdf-brand-logo-dropzone-Large"), {
      dataTransfer: { files: [file] },
    });

    expect(
      await screen.findByAltText(en["admin.pdf-brand.logo.preview-alt"]),
    ).toBeTruthy();
    await waitFor(() =>
      expect(uploadLogo).toHaveBeenCalledWith({
        workspaceId: "ws-1",
        kind: "Large",
        file,
      }),
    );
    finishUpload();
    await waitFor(() =>
      expect(
        screen.queryByAltText(en["admin.pdf-brand.logo.preview-alt"]),
      ).toBeNull(),
    );
  });

  test("shows and deletes an existing logo slot", async () => {
    renderWithFacade(<BrandAssetsTab />);
    await chooseWorkspace();

    expect(screen.getByText("small.svg")).toBeTruthy();
    fireEvent.click(screen.getByText(en["admin.common.delete"]));
    fireEvent.click(await screen.findByTestId("admin-confirm-modal-confirm"));

    await waitFor(() =>
      expect(deleteLogo).toHaveBeenCalledWith({
        workspaceId: "ws-1",
        kind: "Small",
      }),
    );
  });

  test("validates colors before save and persists valid color changes", async () => {
    renderWithFacade(<BrandAssetsTab />);
    await chooseWorkspace();

    const primary = screen.getByLabelText(en["admin.pdf-brand.colors.primary"]);
    const accent = screen.getByLabelText(en["admin.pdf-brand.colors.accent"]);
    const colorSaveButton = () => {
      const button = screen.getByTestId(
        "pdf-brand-custom-colors-save",
      ) as HTMLButtonElement;
      if (!button) {
        throw new Error("Custom color save button not found");
      }
      return button;
    };

    fireEvent.change(primary, { target: { value: "red" } });
    expect(colorSaveButton().disabled).toBe(true);

    fireEvent.change(primary, { target: { value: "#abcdef" } });
    fireEvent.change(accent, { target: { value: "" } });
    expect(
      screen.getByText(en["admin.pdf-brand.colors.pair-required"]),
    ).toBeTruthy();
    expect(colorSaveButton().disabled).toBe(true);

    fireEvent.change(accent, { target: { value: "#445566" } });
    fireEvent.change(primary, { target: { value: "#abcdef" } });
    fireEvent.click(colorSaveButton());

    await waitFor(() =>
      expect(updateColors).toHaveBeenCalledWith({
        workspaceId: "ws-1",
        primary: "#abcdef",
        accent: "#445566",
      }),
    );
  });

  test("selects server-resolved document palettes by policy instead of duplicating colors", async () => {
    renderWithFacade(<BrandAssetsTab />);
    await chooseWorkspace();

    fireEvent.click(screen.getByText(en["admin.pdf-brand.palette.balanced"]));

    await waitFor(() =>
      expect(setColorPolicy).toHaveBeenCalledWith({
        workspaceId: "ws-1",
        policy: "theme_palette",
        paletteKey: "balanced",
      }),
    );
    expect(updateColors).not.toHaveBeenCalled();
  });

  test("resets workspace document branding through the dedicated server mutation", async () => {
    renderWithFacade(<BrandAssetsTab />);
    await chooseWorkspace();

    fireEvent.click(screen.getByText(en["admin.pdf-brand.reset.action"]));
    fireEvent.click(await screen.findByTestId("admin-confirm-modal-confirm"));

    await waitFor(() =>
      expect(resetBranding).toHaveBeenCalledWith({ workspaceId: "ws-1" }),
    );
    expect(mutateAsset).toHaveBeenCalled();
  });

  test("persists document branding text changes", async () => {
    renderWithFacade(<BrandAssetsTab />);
    await chooseWorkspace();

    fireEvent.change(
      screen.getByLabelText(en["admin.pdf-brand.text.footer-text"]),
      {
        target: { value: "Board packet" },
      },
    );
    fireEvent.click(screen.getAllByText(en["admin.common.save"])[0]);

    await waitFor(() =>
      expect(updateText).toHaveBeenCalledWith({
        workspaceId: "ws-1",
        footerText: "Board packet",
      }),
    );
  });

  test("retains workspace-owned text/color drafts and discards explicitly without writes", async () => {
    const { container } = renderWithFacade(<BrandAssetsTab />);
    await chooseWorkspace();
    const input = (name: string) =>
      screen.getByRole("textbox", { name }) as HTMLInputElement;
    fireEvent.change(input("Footer text"), {
      target: { value: "Alpha draft" },
    });
    fireEvent.change(input("Primary color"), { target: { value: "#abcdef" } });
    await chooseWorkspace("Workspace Two");
    expect(input("Footer text").value).toBe("Confidential");
    fireEvent.change(input("Footer text"), { target: { value: "Beta draft" } });
    await chooseWorkspace();
    expect(input("Footer text").value).toBe("Alpha draft");
    expect(input("Primary color").value).toBe("#abcdef");
    const ids = Array.from(container.querySelectorAll("input[id]")).map(
      (e) => e.id,
    );
    expect(new Set(ids).size).toBe(ids.length);
    fireEvent.click(screen.getAllByRole("button", { name: "Discard" })[0]);
    fireEvent.click(screen.getAllByRole("button", { name: "Discard" })[1]);
    expect(input("Footer text").value).toBe("Confidential");
    expect(input("Primary color").value).toBe("#112233");
    await chooseWorkspace("Workspace Two");
    expect(input("Footer text").value).toBe("Beta draft");
    expect(updateText).not.toHaveBeenCalled();
    expect(updateColors).not.toHaveBeenCalled();
  });

  test("keeps a failed save draft and disables editing until authoritative readback finishes", async () => {
    renderWithFacade(<BrandAssetsTab />);
    await chooseWorkspace();
    const footer = () =>
      screen.getByRole("textbox", {
        name: "Footer text",
      }) as HTMLInputElement;
    fireEvent.change(footer(), { target: { value: "Keep this draft" } });
    updateText.mockRejectedValueOnce(new Error("Write rejected"));
    fireEvent.click(screen.getAllByRole("button", { name: "Save" })[0]);
    await waitFor(() =>
      expect(notifyMock.error).toHaveBeenCalledWith({
        title: en["admin.pdf-brand.text.save-failed"],
        message: "Write rejected",
      }),
    );
    expect(footer().value).toBe("Keep this draft");
    let finish!: () => void;
    mutateAsset.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({});
        }),
    );
    fireEvent.click(screen.getAllByRole("button", { name: "Save" })[0]);
    await waitFor(() => expect(mutateAsset).toHaveBeenCalledTimes(1));
    expect(footer().disabled).toBe(true);
    await chooseWorkspace("Workspace Two");
    await chooseWorkspace();
    expect(footer().disabled).toBe(true);
    expect(footer().value).toBe("Keep this draft");
    finish();
    await waitFor(() => expect(footer().disabled).toBe(false));
    expect(
      (
        screen.getAllByRole("button", {
          name: "Save",
        })[0] as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  test("does not overwrite dirty text or color pairs with external server readback", async () => {
    const { rerender } = renderWithFacade(<BrandAssetsTab />);
    await chooseWorkspace();
    const input = (name: string) =>
      screen.getByRole("textbox", { name }) as HTMLInputElement;
    fireEvent.change(input("Footer text"), { target: { value: "My draft" } });
    fireEvent.change(input("Primary color"), { target: { value: "#abcdef" } });
    Object.assign(profiles["ws-1"], {
      footerText: "External footer",
      brandColorPrimary: "#123456",
      brandColorAccent: "#654321",
    });
    rerender(
      <MyoxusUIProvider env="test">
        <BrandAssetsTab />
      </MyoxusUIProvider>,
    );
    expect(input("Footer text").value).toBe("My draft");
    expect(input("Primary color").value).toBe("#abcdef");
    expect(input("Accent color").value).toBe("#445566");
    fireEvent.click(screen.getAllByRole("button", { name: "Discard" })[0]);
    fireEvent.click(screen.getAllByRole("button", { name: "Discard" })[1]);
    expect(input("Footer text").value).toBe("External footer");
    expect(input("Primary color").value).toBe("#123456");
    expect(input("Accent color").value).toBe("#654321");
  });

  test("clears only the confirmed workspace drafts after explicit branding reset", async () => {
    renderWithFacade(<BrandAssetsTab />);
    await chooseWorkspace();
    fireEvent.change(screen.getByRole("textbox", { name: "Footer text" }), {
      target: { value: "Alpha draft" },
    });
    await chooseWorkspace("Workspace Two");
    fireEvent.change(screen.getByRole("textbox", { name: "Footer text" }), {
      target: { value: "Beta draft" },
    });
    await chooseWorkspace();
    fireEvent.click(
      screen.getByRole("button", {
        name: en["admin.pdf-brand.reset.action"],
      }),
    );
    fireEvent.click(await screen.findByTestId("admin-confirm-modal-confirm"));
    await waitFor(() =>
      expect(
        (
          screen.getByRole("textbox", {
            name: "Footer text",
          }) as HTMLInputElement
        ).value,
      ).toBe("Confidential"),
    );
    await chooseWorkspace("Workspace Two");
    expect(
      (
        screen.getByRole("textbox", {
          name: "Footer text",
        }) as HTMLInputElement
      ).value,
    ).toBe("Beta draft");
  });
});
