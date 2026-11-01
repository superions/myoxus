/**
 * @vitest-environment happy-dom
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type * as ReactModule from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@myoxus/i18n", () => ({
  Trans: ({ children }: any) => children,
  useI18n: () =>
    ({
      "com.myoxus.auth.open.myoxus.download-app": () => "Download app",
      "com.myoxus.auth.open.myoxus.doc.open-here": () => "Open here",
      "com.myoxus.auth.open.myoxus.try-again": () => "Try again",
      "com.myoxus.auth.open.myoxus.doc.edit-settings": () => "Edit settings",
      "com.myoxus.auth.open.myoxus.doc.footer-text": () => "Footer text",
    }) as any,
}));

vi.mock("@myoxus/core/modules/dialogs", () => ({
  WorkspaceDialogService: Symbol("WorkspaceDialogService"),
}));

vi.mock("@myoxus/infra", () => ({
  useServiceOptional: () => null,
}));

vi.mock("@myoxus/core/utils/channel", () => ({
  appNames: { stable: "Myoxus" },
}));

vi.mock("@myoxus/ui-facade", async () => {
  const React = await vi.importActual<typeof ReactModule>("react");
  const passthrough = ({
    alignItems: _alignItems,
    align: _align,
    centerContent: _centerContent,
    fallbackSlot: _fallbackSlot,
    fill: _fill,
    gap: _gap,
    justifyContent: _justifyContent,
    justify: _justify,
    textAlign: _textAlign,
    tone: _tone,
    typographySlot: _typographySlot,
    width: _width,
    w: _w,
    wrap: _wrap,
    ...props
  }: any) => props;
  return {
    Group: ({ children, ...props }: any) => (
      <div {...passthrough(props)}>{children}</div>
    ),
    InlineActionButton: ({ children, ...props }: any) => (
      <button type="button" {...props}>
        {children}
      </button>
    ),
    InlineLink: ({ children, href, rel, target }: any) => (
      <a href={href} rel={rel} target={target}>
        {children}
      </a>
    ),
    MyoxusOtherPageLayout: ({ children, downloadUrl }: any) => (
      <div data-testid="other-page-layout" data-download-url={downloadUrl}>
        <button type="button">Download app</button>
        {children}
      </div>
    ),
    MyoxusText: ({
      children,
      component: Component = "span",
      ...props
    }: any) => <Component {...passthrough(props)}>{children}</Component>,
    OtherPageHeroProductMark: ({ alt, ...props }: any) => {
      const [failed, setFailed] = React.useState(false);
      if (failed) {
        return (
          <svg
            aria-label={alt}
            data-testid="hero-product-mark-fallback"
            role="img"
          />
        );
      }
      return (
        <img
          alt={alt}
          src="/myoxus/style/product-mark.svg"
          {...props}
          onError={() => setFailed(true)}
        />
      );
    },
    PageContentRail: ({ children, ...props }: any) => (
      <main {...passthrough(props)}>{children}</main>
    ),
    Stack: ({ children, ...props }: any) => (
      <div {...passthrough(props)}>{children}</div>
    ),
  };
});

vi.mock("@myoxus/icons/react", () => ({
  LocalWorkspaceIcon: ({ size, ...props }: any) => (
    <svg data-size={size} data-testid="local-workspace-icon" {...props} />
  ),
}));

import { OpenInAppPage } from "./open-in-app-page";

describe("OpenInAppPage branding assets", () => {
  beforeEach(() => {
    (globalThis as any).environment = {
      subPath: "/myoxus",
    };
    (globalThis as any).BUILD_CONFIG = {
      appBuildType: "stable",
      downloadUrl: "https://example.invalid/download",
    };
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  test("uses the facade other-page layout with the download URL", () => {
    render(<OpenInAppPage urlToOpen={window.location.href} />);

    const layout = screen.getByTestId("other-page-layout");
    expect(layout.getAttribute("data-download-url")).toBe(
      "https://example.invalid/download",
    );
    expect(screen.getByRole("button", { name: "Download app" })).toBeTruthy();
  });

  test("renders product mark from branding path", () => {
    render(<OpenInAppPage urlToOpen={window.location.href} />);

    const image = screen.getByRole("img", { name: "Myoxus App Icon" });
    expect(image.getAttribute("src")).toBe("/myoxus/style/product-mark.svg");
  });

  test("falls back to icon when product mark is missing", () => {
    render(<OpenInAppPage urlToOpen={window.location.href} />);

    const image = screen.getByRole("img", { name: "Myoxus App Icon" });
    fireEvent.error(image);

    expect(screen.getByTestId("hero-product-mark-fallback")).toBeTruthy();
  });

  test("renders open-doc actions through facade action and link roles", () => {
    const openHereClicked = vi.fn((event) => event.preventDefault());
    render(
      <OpenInAppPage
        mode="open-doc"
        openHereClicked={openHereClicked}
        urlToOpen="myoxus://open"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open here" }));
    expect(openHereClicked).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("link", { name: "Try again" }).getAttribute("href"),
    ).toBe("myoxus://open");
    expect(screen.getByRole("button", { name: "Edit settings" })).toBeTruthy();
    expect(
      screen.getByTestId("local-workspace-icon").getAttribute("data-size"),
    ).toBe("1em");
  });

  test("does not launch a custom protocol without active user interaction", () => {
    const hrefBeforeRender = window.location.href;
    vi.stubGlobal("navigator", {
      ...window.navigator,
      userActivation: { hasBeenActive: false, isActive: false },
    });

    render(<OpenInAppPage urlToOpen="myoxus://open?action=phase07" />);

    expect(window.location.href).toBe(hrefBeforeRender);
    expect(
      screen.getByRole("link", { name: "Try again" }).getAttribute("href"),
    ).toBe("myoxus://open?action=phase07");
  });
});
