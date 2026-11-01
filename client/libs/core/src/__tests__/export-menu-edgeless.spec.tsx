/**
 * @vitest-environment happy-dom
 *
 * Edgeless PDF-Export menu — superseded V2 contract (todo/pdf-refactoring.md:1238).
 *
 * Background: V1 of the server-side PDF flow shipped without edgeless support
 * (the legacy clientseitige Edgeless-PDF wurde entfernt; this menu item was
 * disabled with an "Unavailable for edgeless" tag). V2 closes the gap by
 * rasterizing the surface clientseitig before kicking off the server export
 * (`ExportManager.captureEdgelessSnapshotForExport()`), so the menu must now
 * be *enabled* in both modes.
 *
 * Invariants:
 *  - INV-PDF-EXPORT-MENU-01: pageMode="page" — pdf-export item is rendered and
 *    enabled (no `data-disabled`) and carries no Unavailable tag.
 *  - INV-PDF-EXPORT-MENU-02: pageMode="edgeless" — pdf-export item is
 *    rendered, enabled (no `data-disabled`) and carries no Unavailable tag —
 *    the V1 deactivation has been lifted now that the client uploads a
 *    raster snapshot before the server export.
 *  - INV-PDF-EXPORT-MENU-03: the Unavailable-tag i18n key
 *    `com.myoxus.export.pdf.edgeless-unavailable-tag` is no longer rendered
 *    for any pageMode (locks the V2 contract — a regression here would mean
 *    the legacy disabled UI was reintroduced).
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("@myoxus/ui-facade", () => ({
  MenuItem: ({
    children,
    disabled,
    suffix,
    "data-testid": dataTestId,
  }: {
    children: React.ReactNode;
    disabled?: boolean;
    suffix?: React.ReactNode;
    "data-testid"?: string;
  }) => (
    <div data-testid={dataTestId} data-disabled={disabled ? "true" : undefined}>
      <span data-testid={`${dataTestId}-label`}>{children}</span>
      {suffix ? (
        <span data-testid={`${dataTestId}-suffix`}>{suffix}</span>
      ) : null}
    </div>
  ),
  MenuSeparator: () => <hr />,
  MenuSub: ({
    items,
    children,
  }: {
    items: React.ReactNode;
    children: React.ReactNode;
  }) => (
    <div>
      <div data-testid="menu-sub-trigger">{children}</div>
      <div data-testid="menu-sub-items">{items}</div>
    </div>
  ),
}));

vi.mock("@myoxus/track", () => ({
  track: {
    $: {
      header: { docOptions: { export: () => {} } },
      sharePanel: { $: { export: () => {} } },
    },
  },
}));

vi.mock("@myoxus/icons/react", () => ({
  ExportIcon: () => null,
  ExportToHtmlIcon: () => null,
  ExportToMarkdownIcon: () => null,
  ExportToPngIcon: () => null,
  PageIcon: () => null,
  PrinterIcon: () => null,
}));

import { ExportMenuItems } from "../components/page-list/operation-menu-items/export";

describe("ExportMenuItems — edgeless pdf-export V2 (#1238)", () => {
  afterEach(() => {
    cleanup();
  });

  test("INV-PDF-EXPORT-MENU-01: pageMode=page is enabled, no Unavailable tag", () => {
    render(<ExportMenuItems exportHandler={() => {}} pageMode="page" />);
    const item = screen.getByTestId("export-to-pdf-export");
    expect(item).toBeTruthy();
    expect(Object.hasOwn(item.dataset, "disabled")).toBe(false);
    expect(
      screen.queryByTestId("export-to-pdf-export-unavailable-tag"),
    ).toBeNull();
  });

  test("INV-PDF-EXPORT-MENU-02: pageMode=edgeless is now enabled (V1 deactivation lifted)", () => {
    render(<ExportMenuItems exportHandler={() => {}} pageMode="edgeless" />);
    const item = screen.getByTestId("export-to-pdf-export");
    expect(item).toBeTruthy();
    expect(Object.hasOwn(item.dataset, "disabled")).toBe(false);
  });

  test("INV-PDF-EXPORT-MENU-03: Unavailable tag is gone for both modes", () => {
    render(<ExportMenuItems exportHandler={() => {}} pageMode="page" />);
    expect(
      screen.queryByTestId("export-to-pdf-export-unavailable-tag"),
    ).toBeNull();
    cleanup();
    render(<ExportMenuItems exportHandler={() => {}} pageMode="edgeless" />);
    expect(
      screen.queryByTestId("export-to-pdf-export-unavailable-tag"),
    ).toBeNull();
  });
});
