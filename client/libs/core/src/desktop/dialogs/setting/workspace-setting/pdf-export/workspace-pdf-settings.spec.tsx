/**
 * @vitest-environment happy-dom
 */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ElementType, ReactNode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("@myoxus/i18n", () => {
  const translations: Record<string, string> = {
    "com.myoxus.settings.workspace.pdf-export.header.title": "PDF Export",
    "com.myoxus.settings.workspace.pdf-export.header.subtitle":
      "Workspace PDF export settings",
    "com.myoxus.settings.workspace.pdf-export.notice.title":
      "Managed by admins",
    "com.myoxus.settings.workspace.pdf-export.notice.text":
      "Configure the catalog in the admin frontend",
    "com.myoxus.settings.workspace.pdf-export.notice.admin-link":
      "PDF Export admin module",
    "com.myoxus.settings.workspace.pdf-export.template.default":
      "Workspace default",
    "com.myoxus.settings.workspace.pdf-export.capability.cover": "Cover",
    "com.myoxus.settings.workspace.pdf-export.capability.toc": "TOC",
    "com.myoxus.settings.workspace.pdf-export.capability.locales":
      "{{count}} locales",
    "com.myoxus.settings.workspace.pdf-export.capability.none":
      "No optional capabilities",
    "com.myoxus.settings.workspace.pdf-export.value.not-configured":
      "Not configured",
    "com.myoxus.settings.workspace.pdf-export.value.enabled": "Enabled",
    "com.myoxus.settings.workspace.pdf-export.logo.large": "Large logo",
    "com.myoxus.settings.workspace.pdf-export.logo.small": "Small logo",
    "com.myoxus.settings.workspace.pdf-export.logo.empty": "No logo configured",
    "com.myoxus.settings.workspace.pdf-export.template.empty":
      "No PDF templates are assigned.",
    "com.myoxus.settings.workspace.pdf-export.error.label": "Load error",
    Retry: "Retry",
  };
  const t = new Proxy(
    {},
    {
      get: (_target, key: string) => (params?: Record<string, string>) => {
        let text = translations[key] ?? key;
        for (const [name, value] of Object.entries(params ?? {})) {
          text = text.replace(`{{${name}}}`, value);
        }
        return text;
      },
    },
  );
  return { useI18n: () => t };
});

vi.mock("../../primitives", () => ({
  Badge: ({ children }: { children: ReactNode }) => (
    <span data-myoxus-ui-role="badge">{children}</span>
  ),
  Button: ({
    children,
    disabled,
    onClick,
    ...rest
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...rest} disabled={disabled} onClick={onClick}>
      {children}
    </button>
  ),
  ColorSwatch: ({
    "aria-label": ariaLabel,
    color,
  }: {
    "aria-label"?: string;
    color: string;
  }) => (
    <span
      aria-label={ariaLabel}
      data-color={color}
      data-myoxus-ui-role="color-swatch"
    />
  ),
  Group: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  InlineLink: ({ children, href }: { children: ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
  MediaPreviewFrame: ({ children }: { children: ReactNode }) => (
    <div data-myoxus-ui-role="media-preview-frame">{children}</div>
  ),
  MediaPreviewImage: ({ alt, src }: { alt: string; src: string }) => (
    <img alt={alt} src={src} data-myoxus-ui-role="media-preview-image" />
  ),
  MyoxusText: ({
    children,
    component,
  }: {
    children: ReactNode;
    component?: ElementType;
  }) => {
    const Component = component ?? "span";
    return (
      <Component data-myoxus-ui-role="typography:text">{children}</Component>
    );
  },
  SettingsPage: ({
    children,
    title,
    subtitle,
  }: {
    children: ReactNode;
    title: ReactNode;
    subtitle?: ReactNode;
  }) => (
    <main>
      <header>
        <h1>{title}</h1>
        {subtitle ? <p>{subtitle}</p> : null}
      </header>
      {children}
    </main>
  ),
  SettingsSection: ({
    children,
    title,
  }: {
    children: ReactNode;
    title?: ReactNode;
  }) => (
    <section>
      {title ? <h2>{title}</h2> : null}
      {children}
    </section>
  ),
  SettingsControlEmpty: ({ children }: { children: ReactNode }) => (
    <p data-myoxus-ui-role="settings-control-empty">{children}</p>
  ),
  SettingsControlList: ({ children }: { children: ReactNode }) => (
    <div data-myoxus-ui-role="settings-control-list">{children}</div>
  ),
  SettingsDefinitionItem: ({
    children,
    label,
  }: {
    children: ReactNode;
    label: ReactNode;
  }) => (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  ),
  SettingsDefinitionList: ({ children }: { children: ReactNode }) => (
    <dl>{children}</dl>
  ),
  SettingsListItemMeta: ({ children }: { children: ReactNode }) => (
    <span>{children}</span>
  ),
  SettingsListItemTitle: ({ children }: { children: ReactNode }) => (
    <strong>{children}</strong>
  ),
  SettingsNotice: ({
    children,
    role,
    title,
  }: {
    children: ReactNode;
    role?: string;
    title: ReactNode;
  }) => (
    <aside role={role} data-myoxus-ui-role="settings-notice">
      <strong>{title}</strong>
      {children}
    </aside>
  ),
  Stack: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SurfaceListItem: ({
    alignItems: _alignItems,
    children,
    component,
    density: _density,
    justifyContent: _justifyContent,
    layout: _layout,
    ...rest
  }: {
    alignItems?: string;
    children: ReactNode;
    component?: ElementType;
    density?: string;
    justifyContent?: string;
    layout?: string;
  }) => {
    const Component = component ?? "div";
    return <Component {...rest}>{children}</Component>;
  },
  SurfaceListItemMain: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  SurfaceListMeta: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock("@myoxus/core/modules/server", () => ({
  GraphQLService: Symbol("GraphQLService"),
}));

vi.mock("@myoxus/core/modules/workspace", () => ({
  WorkspaceService: Symbol("WorkspaceService"),
}));

vi.mock("@myoxus/infra", () => ({
  useService: vi.fn(),
}));

import { WorkspacePdfExportSettingsView } from ".";

const bootstrap = {
  availablePdfTemplates: [
    {
      id: "tpl-default",
      slug: "default",
      name: "Default",
      version: "1.0.0",
      schemaVersion: "2.0",
      isDefault: true,
      capabilities: {
        language: { kind: "enum", values: ["en", "de"], default: "en" },
        tocBehavior: { kind: "enum", values: ["off", "auto"], default: "off" },
        coverPage: { kind: "boolean", default: false },
      },
    },
    {
      id: "tpl-report",
      slug: "report",
      name: "Report",
      version: "2.0.0",
      schemaVersion: "2.0",
      isDefault: false,
      capabilities: {},
    },
  ],
  pdfExportSettings: {
    workspaceId: "ws-1",
    defaultTemplateId: "tpl-default",
    defaultLocale: "de",
    defaultPaperSize: "A4",
    defaultColorProfile: "sRGB v4",
    defaultImageQuality: "high",
    ligaturesEnabled: true,
  },
  documentBrandingProfile: {
    workspaceId: "ws-1",
    logoLargeBlob: "pdf-brand/ws-1/large.svg",
    logoSmallBlob: null,
    footerText: "Confidential board pack",
    brandColorPrimary: "#123456",
    brandColorAccent: "#abcdef",
    defaultTemplateId: "tpl-default",
    defaultLocale: "de",
    defaultPaperSize: "A4",
    defaultColorProfile: "sRGB v4",
    defaultImageQuality: "high",
    ligaturesEnabled: true,
  },
};

describe("Workspace PDF export settings", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  test("renders assigned templates, document branding, defaults, and admin hint", async () => {
    const gql = vi.fn().mockResolvedValue(bootstrap);

    render(
      <WorkspacePdfExportSettingsView
        graphqlService={{ gql } as never}
        workspaceId="ws-1"
      />,
    );

    await screen.findAllByRole("article");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "PDF Export",
    );
    expect(screen.getByRole("complementary").textContent).toContain(
      "Managed by admins",
    );
    expect(
      screen
        .getByRole("link", { name: "PDF Export admin module" })
        .getAttribute("href"),
    ).toBe("/adminfrontend/pdf-export");

    const cards = screen.getAllByRole("article");
    expect(cards).toHaveLength(2);
    expect(cards[0].textContent).toBe(
      "Defaultdefault · v1.0.0 · schema 2.0CoverTOC2 localesWorkspace default",
    );
    expect(cards[1].textContent).toBe(
      "Reportreport · v2.0.0 · schema 2.0No optional capabilities",
    );
    expect(
      screen.getByText("Confidential board pack").closest("dd")?.textContent,
    ).toBe("Confidential board pack");
    expect(screen.queryByText("Interstate")).toBeNull();
    expect(
      screen
        .getByRole("img", { name: "Large logo preview" })
        .getAttribute("src"),
    ).toBe("/api/workspaces/ws-1/blobs/pdf-brand/ws-1/large.svg");

    expect(
      screen
        .getAllByRole("definition")
        .slice(-6)
        .map((node) => node.textContent),
    ).toEqual(["Default", "A4", "de", "sRGB v4", "high", "Enabled"]);
    expect(gql).toHaveBeenCalledWith(
      expect.objectContaining({ variables: { workspaceId: "ws-1" } }),
    );
  });

  test("renders an empty template state", async () => {
    const gql = vi.fn().mockResolvedValue({
      ...bootstrap,
      availablePdfTemplates: [],
      pdfExportSettings: {
        ...bootstrap.pdfExportSettings,
        defaultTemplateId: null,
      },
    });

    render(
      <WorkspacePdfExportSettingsView
        graphqlService={{ gql } as never}
        workspaceId="ws-empty"
      />,
    );

    await screen.findByText("No PDF templates are assigned.");
    expect(screen.queryAllByRole("article")).toHaveLength(0);
    expect(screen.getAllByText("Not configured").length).toBeGreaterThan(0);
  });

  test("logs load failures and retries on demand", async () => {
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const gql = vi
      .fn()
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce(bootstrap);

    render(
      <WorkspacePdfExportSettingsView
        graphqlService={{ gql } as never}
        workspaceId="ws-1"
      />,
    );

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Load errornetwork downRetry");
    expect(screen.queryAllByRole("article")).toHaveLength(0);
    expect(errorSpy).toHaveBeenCalledWith(
      "[pdf-export-settings] failed to load workspace pdf settings",
      expect.any(Error),
    );

    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(gql).toHaveBeenCalledTimes(2));
    expect(await screen.findAllByRole("article")).toHaveLength(2);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
