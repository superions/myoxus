/**
 * @vitest-environment happy-dom
 */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  applyBrandIdentityDocumentMetadata,
  BrandAssetImage,
  BrandIdentityProvider,
  clearBrandIdentityCache,
  getBrandAssetUrl,
  loadBrandIdentity,
  setBrandIdentityServerPath,
} from "./brand-asset-image";

describe("BrandAssetImage", () => {
  beforeEach(() => {
    (globalThis as any).environment = {
      subPath: "/myoxus",
    };
    clearBrandIdentityCache();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: Parameters<typeof fetch>[0]) => {
        const url = String(input);
        if (url === "/myoxus/api/branding/app-server.json") {
          return {
            ok: true,
            json: async () => ({
              appServerBranding: {
                logo: { publicUrl: "/style/logo.svg?v=server" },
                productMark: {
                  publicUrl: "/style/product-mark.svg?v=server",
                },
                faviconPack: {
                  publicUrl: "/favicon-192.png?v=server",
                },
              },
            }),
          };
        }
        return { ok: false, json: async () => ({}) };
      }),
    );
  });

  afterEach(() => {
    cleanup();
    setBrandIdentityServerPath(undefined);
    vi.unstubAllGlobals();
  });

  test("native server switches scope JSON and assets, while no registered server uses only bundled branding", async () => {
    (globalThis as any).environment = { subPath: undefined };
    vi.mocked(fetch).mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            appServerBranding: {
              logo: { publicUrl: "/api/branding/logo.svg" },
            },
          }),
        ),
    );
    setBrandIdentityServerPath("/_server/alpha");
    await expect(getBrandAssetUrl("logo")).resolves.toBe(
      "/_server/alpha/api/branding/logo.svg",
    );
    expect(fetch).toHaveBeenLastCalledWith(
      "/_server/alpha/api/branding/app-server.json",
      expect.anything(),
    );
    setBrandIdentityServerPath("/_server/beta");
    await expect(getBrandAssetUrl("logo")).resolves.toBe(
      "/_server/beta/api/branding/logo.svg",
    );
    expect(fetch).toHaveBeenLastCalledWith(
      "/_server/beta/api/branding/app-server.json",
      expect.anything(),
    );
    setBrandIdentityServerPath(null);
    await loadBrandIdentity();
    expect(fetch).toHaveBeenLastCalledWith(
      "/style/brand-identity-fallback.json",
      expect.anything(),
    );
  });

  test("loads logo url from server-owned app branding projection", async () => {
    await expect(getBrandAssetUrl("logo")).resolves.toBe(
      "/myoxus/style/logo.svg?v=server",
    );
  });

  test("loads product mark url from server-owned app branding projection", async () => {
    await expect(getBrandAssetUrl("productMark")).resolves.toBe(
      "/myoxus/style/product-mark.svg?v=server",
    );
  });

  test("exposes loading state source for the runtime provider contract", async () => {
    await expect(loadBrandIdentity()).resolves.toMatchObject({
      status: "ready",
      source: "server",
      schemaVersion: undefined,
      appServerBranding: {
        logo: { publicUrl: "/style/logo.svg?v=server" },
      },
    });
  });

  test("falls back to static brand identity manifest when API is unavailable", async () => {
    vi.mocked(fetch).mockImplementation(
      async (input: Parameters<typeof fetch>[0]) => {
        const url = String(input);
        if (url === "/myoxus/style/brand-identity-fallback.json") {
          return {
            ok: true,
            json: async () => ({
              appServerBranding: {
                logo: { publicUrl: "/style/logo.svg?v=fallback" },
              },
            }),
          } as Response;
        }
        return { ok: false, json: async () => ({}) } as Response;
      },
    );
    clearBrandIdentityCache();

    await expect(getBrandAssetUrl("logo")).resolves.toBe(
      "/myoxus/style/logo.svg?v=fallback",
    );
  });

  test("rejects external asset URLs instead of loading CDN or data defaults", async () => {
    vi.mocked(fetch).mockImplementation(async () => {
      return {
        ok: true,
        json: async () => ({
          appServerBranding: {
            logo: { publicUrl: "https://cdn.example.invalid/logo.svg" },
            productMark: { publicUrl: "data:image/svg+xml,<svg />" },
          },
        }),
      } as Response;
    });
    clearBrandIdentityCache();

    await expect(getBrandAssetUrl("logo")).resolves.toBeUndefined();
    await expect(getBrandAssetUrl("productMark")).resolves.toBeUndefined();
  });

  test("renders image and swaps to fallback when asset load fails", async () => {
    render(
      <BrandAssetImage
        slot="productMark"
        fallback={<span data-testid="fallback">Fallback</span>}
      />,
    );

    const image = await screen.findByRole("img", {
      name: "Myoxus Product Mark",
    });
    expect(image.getAttribute("src")).toBe(
      "/myoxus/style/product-mark.svg?v=server",
    );

    fireEvent.error(image);
    expect(
      screen.queryByRole("img", { name: "Myoxus Product Mark" }),
    ).toBeNull();
    expect(screen.getByTestId("fallback")).not.toBeNull();
  });

  test("uses static same-origin product mark fallback when no explicit fallback is provided", async () => {
    render(<BrandAssetImage slot="productMark" />);

    const image = await screen.findByRole("img", {
      name: "Myoxus Product Mark",
    });
    expect(image.getAttribute("src")).toBe(
      "/myoxus/style/product-mark.svg?v=server",
    );

    fireEvent.error(image);
    await waitFor(() => {
      const fallbackImage = screen.getByRole("img", {
        name: "Myoxus Product Mark",
      });
      expect(fallbackImage.getAttribute("src")).toBe(
        "/myoxus/style/product-mark.svg",
      );
    });
  });

  test("uses BrandIdentityProvider state for shell image consumers", async () => {
    render(
      <BrandIdentityProvider>
        <BrandAssetImage slot="logo" />
      </BrandIdentityProvider>,
    );

    const image = await screen.findByRole("img", {
      name: "Myoxus Logo",
    });
    expect(image.getAttribute("src")).toBe("/myoxus/style/logo.svg?v=server");
  });

  test("applies favicon and social metadata from the runtime contract", async () => {
    const doc = document.implementation.createHTMLDocument("metadata");
    const twitter = doc.createElement("meta");
    twitter.name = "twitter:image";
    doc.head.append(twitter);
    const og = doc.createElement("meta");
    og.setAttribute("property", "og:image");
    doc.head.append(og);

    await applyBrandIdentityDocumentMetadata(doc);

    expect(twitter.content).toContain("/myoxus/style/logo.svg?v=server");
    expect(og.content).toContain("/myoxus/style/logo.svg?v=server");
    for (const size of [32, 36, 48, 72, 96, 144, 192]) {
      expect(
        (
          doc.head.querySelector(
            `link[rel="icon"][sizes="${size}x${size}"]`,
          ) as HTMLLinkElement
        ).href,
      ).toContain(`/myoxus/favicon-${size}.png?v=server`);
    }
    expect(
      (doc.head.querySelector('link[rel="shortcut icon"]') as HTMLLinkElement)
        .href,
    ).toContain("/myoxus/favicon-192.png?v=server");
  });
});
