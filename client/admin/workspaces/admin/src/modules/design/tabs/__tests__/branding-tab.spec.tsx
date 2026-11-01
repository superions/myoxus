import type { ReactElement } from "react";
/** @vitest-environment happy-dom */
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  act,
  waitFor,
} from "@testing-library/react";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import enJson from "../../../../../../../../libs/i18n/src/resources/en.json";

const en: Record<string, string> = enJson;

// `environment` is a global injected by the admin runtime — stub it here.
(globalThis as any).environment = { subPath: "" };

vi.mock("@myoxus/i18n", () => ({
  useI18n: () => ({
    t: (key: string, vars?: Record<string, string>): string => {
      const tpl = en[key] ?? key;
      if (!vars) return tpl;
      return Object.entries(vars).reduce(
        (acc, [k, v]) => acc.replace(new RegExp(`{{${k}}}`, "g"), v),
        tpl,
      );
    },
  }),
}));

// `notify` is a side-effect surface, no return value relied on here.
vi.mock("@myoxus/ui-facade", async (importOriginal) => {
  const actual = await importOriginal<object>();
  return {
    ...actual,
    notify: { success: vi.fn(), error: vi.fn() },
    notifyBrandIdentityUpdated: vi.fn(),
  };
});

const revalidateMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const updateOrganizationIdentityMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue({}),
);

// `useMutateQueryResource` returns a tracked revalidator for the tests.
vi.mock("../../../../use-mutation", () => ({
  useMutateQueryResource: () => revalidateMock,
}));

vi.mock("../../../branding/brand-identity-api", () => ({
  useUpdateOrganizationIdentityMutation: () => ({
    updateOrganizationIdentity: updateOrganizationIdentityMock,
    isMutating: false,
  }),
}));

const adminFetchMock = vi.fn();

vi.mock("../../../../fetch-utils", () => ({
  adminFetch: (...args: unknown[]) => adminFetchMock(...args),
}));

// The graphql operation handle is only used as a cache key.
vi.mock("@myoxus/graphql", () => ({
  adminAppServerBrandingQuery: { id: "adminAppServerBranding" },
}));

import { BrandingTab } from "../branding-tab";

function renderWithFacade(ui: ReactElement) {
  return render(<MyoxusUIProvider>{ui}</MyoxusUIProvider>);
}

const BRANDING = {
  logo: {
    id: "asset-logo",
    slot: "logo",
    variant: "large",
    qualityClass: "web",
    storageKind: "style_static",
    storageKey: "logo.svg",
    mime: "image/svg+xml",
    sha256: "a11ce",
    publicUrl: "/style/logo.svg?v=a11ce",
  },
  productMark: {
    id: "asset-mark",
    slot: "product_mark",
    variant: "mark",
    qualityClass: "web",
    storageKind: "style_static",
    storageKey: "product-mark.svg",
    mime: "image/svg+xml",
    sha256: "b02d",
    publicUrl: "/style/product-mark.svg?v=b02d",
  },
  faviconPack: {
    id: "asset-favicon",
    slot: "favicon_pack",
    variant: "pack",
    qualityClass: "favicon",
    storageKind: "style_static",
    storageKey: "favicon-pack.zip",
    mime: "application/zip",
    sha256: "c0ffee",
    publicUrl: "/favicon-192.png?v=c0ffee",
  },
} as never;

const ORGANIZATION_IDENTITY = {
  displayName: "Acme Research",
  legalName: "Acme Research GmbH",
  shortName: "Acme",
  jurisdiction: "DE",
  websiteUrl: "https://example.test",
  contactEmail: "ops@example.test",
  addressLines: ["Main Street 1", "10115 Berlin"],
  taxId: "DE123",
  registrationId: "HRB 42",
} as never;

describe("BrandingTab (P-AR-1-06)", () => {
  beforeEach(() => {
    updateOrganizationIdentityMock.mockReset();
    updateOrganizationIdentityMock.mockImplementation(async (input) => input);
    revalidateMock.mockReset();
    revalidateMock.mockResolvedValue(undefined);
  });
  afterEach(() => {
    adminFetchMock.mockReset();
    revalidateMock.mockClear();
    updateOrganizationIdentityMock.mockClear();
    cleanup();
  });

  test("saves organization identity through the AdminRoot brand identity hook", async () => {
    renderWithFacade(
      <BrandingTab
        branding={BRANDING}
        organizationIdentity={ORGANIZATION_IDENTITY}
      />,
    );

    fireEvent.change(
      screen.getByLabelText(
        en["admin.design.branding.organization.display-name"],
      ),
      { target: { value: "Acme Labs" } },
    );
    fireEvent.change(
      screen.getByLabelText(
        en["admin.design.branding.organization.address-lines"],
      ),
      { target: { value: "Main Street 1\n\n10115 Berlin" } },
    );
    fireEvent.click(screen.getAllByText(en["admin.common.save"])[0]);

    await waitFor(() =>
      expect(updateOrganizationIdentityMock).toHaveBeenCalledWith({
        displayName: "Acme Labs",
        legalName: "Acme Research GmbH",
        shortName: "Acme",
        jurisdiction: "DE",
        websiteUrl: "https://example.test",
        contactEmail: "ops@example.test",
        addressLines: ["Main Street 1", "10115 Berlin"],
        taxId: "DE123",
        registrationId: "HRB 42",
      }),
    );
  });

  test("async identity readback adopts clean values but preserves a dirty draft", () => {
    const view = renderWithFacade(<BrandingTab branding={BRANDING} />);
    view.rerender(
      <MyoxusUIProvider>
        <BrandingTab
          branding={BRANDING}
          organizationIdentity={ORGANIZATION_IDENTITY}
        />
      </MyoxusUIProvider>,
    );
    const displayName = screen.getByLabelText(
      en["admin.design.branding.organization.display-name"],
    ) as HTMLInputElement;
    expect(displayName.value).toBe("Acme Research");
    fireEvent.change(displayName, { target: { value: "Keep this draft" } });
    view.rerender(
      <MyoxusUIProvider>
        <BrandingTab
          branding={BRANDING}
          organizationIdentity={
            {
              ...(ORGANIZATION_IDENTITY as object),
              displayName: "New server value",
            } as never
          }
        />
      </MyoxusUIProvider>,
    );
    expect(displayName.value).toBe("Keep this draft");
    fireEvent.click(
      screen.getByRole("button", { name: en["admin.common.cancel"] }),
    );
    expect(displayName.value).toBe("New server value");
  });

  test("failed identity Save retains the actual draft and exposes persistent feedback", async () => {
    updateOrganizationIdentityMock.mockRejectedValue(
      new Error("Identity write rejected"),
    );
    renderWithFacade(
      <BrandingTab
        branding={BRANDING}
        organizationIdentity={ORGANIZATION_IDENTITY}
      />,
    );
    const legalName = screen.getByLabelText(
      en["admin.design.branding.organization.legal-name"],
    ) as HTMLInputElement;
    fireEvent.change(legalName, {
      target: { value: "Long legal name retained after rejection" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: en["admin.common.save"] }),
    );
    await screen.findByText("Identity write rejected");
    expect(legalName.value).toBe("Long legal name retained after rejection");
    fireEvent.click(
      screen.getByRole("button", { name: en["admin.common.cancel"] }),
    );
    expect(legalName.value).toBe("Acme Research GmbH");
    expect(screen.queryByText("Identity write rejected")).toBeNull();
  });

  test("upload errors preserve identity drafts and block a duplicate upload through readback", async () => {
    let completeReadback!: () => void;
    revalidateMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          completeReadback = resolve;
        }),
    );
    adminFetchMock.mockResolvedValue(
      new Response(JSON.stringify({ assetPath: "/style/logo.svg" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    renderWithFacade(
      <BrandingTab
        branding={BRANDING}
        organizationIdentity={ORGANIZATION_IDENTITY}
      />,
    );
    const displayName = screen.getByLabelText(
      en["admin.design.branding.organization.display-name"],
    ) as HTMLInputElement;
    fireEvent.change(displayName, {
      target: { value: "Independent identity draft" },
    });
    const zone = screen.getByTestId("design-branding-dropzone-logo");
    const file = new File(["svg"], "logo.svg", { type: "image/svg+xml" });
    fireEvent.drop(zone, { dataTransfer: { files: [file] } });
    await waitFor(() => expect(revalidateMock).toHaveBeenCalledTimes(1));
    fireEvent.drop(zone, { dataTransfer: { files: [file] } });
    expect(adminFetchMock).toHaveBeenCalledTimes(1);
    expect(displayName.value).toBe("Independent identity draft");
    await act(async () => completeReadback());
    adminFetchMock.mockResolvedValue(
      new Response(JSON.stringify({ message: "Invalid SVG" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    );
    fireEvent.drop(zone, { dataTransfer: { files: [file] } });
    await screen.findByText("Invalid SVG");
    expect(screen.getByRole("alert").textContent).toContain("Invalid SVG");
    expect(displayName.value).toBe("Independent identity draft");
    expect(revalidateMock).toHaveBeenCalledTimes(1);
    expect(updateOrganizationIdentityMock).not.toHaveBeenCalled();
  });

  test("inv_preview_light_and_dark_rendered_for_logo_and_mark", () => {
    renderWithFacade(<BrandingTab branding={BRANDING} />);

    // Logo previews — both modes side-by-side
    const logoLight = screen.getByTestId("design-branding-logo-preview-light");
    const logoDark = screen.getByTestId("design-branding-logo-preview-dark");
    expect(logoLight.dataset.theme).toBe("light");
    expect(logoDark.dataset.theme).toBe("dark");
    expect(logoLight.dataset.mantineColorScheme).toBe("light");
    expect(logoDark.dataset.mantineColorScheme).toBe("dark");
    expect(logoLight.querySelector("img")?.getAttribute("src")).toBe(
      "/style/logo.svg?v=a11ce",
    );

    // Product-Mark previews — both modes side-by-side
    const markLight = screen.getByTestId(
      "design-branding-product-mark-preview-light",
    );
    const markDark = screen.getByTestId(
      "design-branding-product-mark-preview-dark",
    );
    expect(markLight.dataset.theme).toBe("light");
    expect(markDark.dataset.theme).toBe("dark");
    expect(markLight.dataset.mantineColorScheme).toBe("light");
    expect(markDark.dataset.mantineColorScheme).toBe("dark");
    expect(markLight.querySelector("img")?.getAttribute("src")).toBe(
      "/style/product-mark.svg?v=b02d",
    );
  });

  test("inv_missing_typed_assets_do_not_fall_back_to_static_brand_paths", () => {
    const brandingWithoutAssets = {
      ...(BRANDING as Record<string, unknown>),
      logo: null,
      productMark: null,
      faviconPack: null,
    };
    renderWithFacade(<BrandingTab branding={brandingWithoutAssets as never} />);

    const logoLight = screen.getByTestId("design-branding-logo-preview-light");
    const markLight = screen.getByTestId(
      "design-branding-product-mark-preview-light",
    );
    const favicons = screen.getByTestId("design-branding-favicon-sizes");

    expect(logoLight.querySelector("img")).toBeNull();
    expect(markLight.querySelector("img")).toBeNull();
    expect(favicons.querySelector("img")).toBeNull();
    expect(logoLight.textContent).toContain(
      en["admin.design.branding.preview.no-asset"],
    );
  });

  test("inv_favicon_pack_upload_uses_existing_branding_endpoint", async () => {
    adminFetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          slot: "faviconPack",
          assetPath: "/favicon-192.png",
          assets: { faviconPack: "/favicon-192.png" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    renderWithFacade(<BrandingTab branding={BRANDING} />);

    const dropzone = screen.getByTestId("design-branding-dropzone-favicon");
    const file = new File(["zip"], "favicon-pack.zip", {
      type: "application/zip",
    });
    fireEvent.drop(dropzone, {
      dataTransfer: { dropEffect: "copy", files: [file] },
    });

    await waitFor(() => expect(adminFetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = adminFetchMock.mock.calls[0] as [
      string,
      { method: string; body: FormData },
    ];
    expect(url).toBe("/api/admin/branding/upload");
    expect(init.method).toBe("POST");
    expect(init.body.get("slot")).toBe("faviconPack");
    expect(init.body.get("file")).toBe(file);
    await waitFor(() => expect(revalidateMock).toHaveBeenCalledTimes(1));
  });
});
